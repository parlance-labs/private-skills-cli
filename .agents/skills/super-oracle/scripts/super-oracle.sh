#!/usr/bin/env bash
# super-oracle.sh — consult codex-fugu (Sakana Fugu Ultra) as an external oracle.
#
# Self-contained: works as a bundled plugin skill (Codex/Claude) or a plain skill
# (Amp). Reads a briefing from a file or stdin, writes the answer to -o OUTPUT.
# Drive it FROM your main agent (Codex/Claude/Amp); never run it from inside a
# codex-fugu session (that asks Fugu Ultra to consult itself).
#
# Usage:
#   super-oracle.sh -o OUTPUT.md BRIEFING.md
#   super-oracle.sh -o OUTPUT.md < BRIEFING.md
#
# Options:
#   -o OUTPUT   Where to write the oracle's answer (required).
#   -C DIR      Working directory for the oracle (default: current dir).
#   -n          Turn MCP servers OFF for this run (default: leave them ON).
#   -p SECONDS  Progress heartbeat interval on stderr (default 30; 0 = off).
#   -h          Help.
#
# Always Fugu Ultra. The model is fixed to fugu-ultra (codex-fugu defaults to
# plain `fugu`); there is intentionally no model flag.
#
# MCP is left ON by default. codex-fugu starts the MCP servers in
# ~/.codex/config.toml; servers that are not logged in print harmless
# `Auth required` warnings at shutdown but do not block (measured overhead is a
# couple of seconds, immaterial for a long-running oracle). We just filter that
# cosmetic noise. Use -n only if you have an MCP server that genuinely hangs;
# -n runs with a temp CODEX_HOME that strips all [mcp_servers.*] from config.toml
# (note: `-c mcp_servers="{}"` does NOT work in exec mode because codex
# deep-merges config). -n requires python3.
#
# Permission posture (read this — true inheritance is impossible):
#   codex does NOT expose the parent agent's approval/sandbox policy to child
#   processes, so the oracle cannot truly "inherit" the parent's flags. It only
#   sees CODEX_SANDBOX / CODEX_SANDBOX_NETWORK_DISABLED. We approximate:
#     - SUPER_ORACLE_SANDBOX=read-only|workspace-write|danger-full-access wins.
#     - Else SUPER_ORACLE_BYPASS=1 forces bypass; =0 forces workspace-write.
#     - Else if a Codex sandbox signal is present (CODEX_SANDBOX is a backend
#       marker like "seatbelt", or the network-disabled flag is set), stay
#       conservative with --sandbox workspace-write rather than escalating.
#     - Else default to --dangerously-bypass-approvals-and-sandbox (unattended).
#   For pure review/advice runs, prefer SUPER_ORACLE_SANDBOX=read-only.
#
# Output: -o captures ONLY codex-fugu's final assistant message. The script
#   prepends an output contract so the oracle puts its full answer in that final
#   message, and writes any supporting files only under SUPER_ORACLE_ARTIFACTS_DIR
#   (default: OUTPUT.artifacts, cleared each run). If -o ends up empty but
#   $ARTIFACTS_DIR/answer.md exists it is recovered into -o, and a manifest of any
#   artifacts is appended to -o. Success = non-empty -o, not codex-fugu's exit code.
#
# Progress: Fugu Ultra runs for minutes, so the script prints a heartbeat to
#   stderr every SUPER_ORACLE_PROGRESS_INTERVAL seconds (default 30; -p overrides;
#   0 disables) with an elapsed-time counter, plus a startup line that sets
#   expectations and a "done in Xm Ys" line at the end, so a long run never feels
#   hung. The first beat comes within ~15s even with a longer interval. Heartbeats
#   go to stderr only and never touch -o.
#
# Noise: codex-internal `WARN codex_*` lines and MCP auth chatter are filtered from
#   displayed stderr so a run reads clean. Set SUPER_ORACLE_VERBOSE=1 to show raw
#   stderr (use if an answer looks wrong/short — catches a rare silent model
#   fallback or context truncation). ERROR lines are never filtered.
set -euo pipefail

MODEL="fugu-ultra"; OUTPUT=""; WORKDIR=""; DISABLE_MCP=0
PROGRESS_INTERVAL="${SUPER_ORACLE_PROGRESS_INTERVAL:-30}"
HB_PID=""   # set later; declared now so cleanup is safe under set -u
# Print the leading comment block (everything from line 2 up to the first
# non-comment line) as help. Scanning beats a hardcoded line range, which has
# silently leaked code into -h whenever the header grew.
usage() { awk 'NR>=2 && /^#/{sub(/^# ?/,""); print; next} NR>=2{exit}' "${BASH_SOURCE[0]}"; exit "${1:-0}"; }

while getopts ":o:C:p:nh" opt; do
  case "$opt" in
    o) OUTPUT="$OPTARG" ;; C) WORKDIR="$OPTARG" ;;
    p) PROGRESS_INTERVAL="$OPTARG" ;;
    n) DISABLE_MCP=1 ;; h) usage 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage 1 ;;
    :) echo "Option -$OPTARG requires an argument" >&2; usage 1 ;;
  esac
done
shift $((OPTIND - 1))

case "$PROGRESS_INTERVAL" in
  ''|*[!0-9]*) echo "ERROR: progress interval must be a non-negative integer (seconds)" >&2; exit 2 ;;
esac
# Bound the length so later `[ -gt ]` arithmetic can't overflow into an error.
[ "${#PROGRESS_INTERVAL}" -le 9 ] || { echo "ERROR: progress interval too large" >&2; exit 2; }

[ -z "$OUTPUT" ] && { echo "ERROR: -o OUTPUT is required" >&2; usage 1; }

# Normalize output to an absolute path now, before any cd, so -C and relative
# paths behave predictably (output lands relative to the caller's cwd).
ORIGPWD="$(pwd)"
case "$OUTPUT" in /*) ;; *) OUTPUT="$ORIGPWD/$OUTPUT" ;; esac
OUTDIR="$(dirname "$OUTPUT")"
[ -d "$OUTDIR" ] || { echo "ERROR: output directory not found: $OUTDIR" >&2; exit 1; }

# Normalize -C too (absolute), so the artifacts-dir safety check below can
# reliably refuse it even when the caller passed a relative path.
if [ -n "$WORKDIR" ]; then
  case "$WORKDIR" in /*) ;; *) WORKDIR="$ORIGPWD/$WORKDIR" ;; esac
  WORKDIR="${WORKDIR%/}"
  [ -d "$WORKDIR" ] || { echo "ERROR: -C directory not found: $WORKDIR" >&2; exit 1; }
fi

[ "$#" -le 1 ] || { echo "ERROR: expected at most one briefing file" >&2; usage 1; }
BRIEFING_SRC=""
if [ "$#" -ge 1 ] && [ "$1" != "-" ]; then
  BRIEFING_SRC="$1"
  case "$BRIEFING_SRC" in /*) ;; *) BRIEFING_SRC="$ORIGPWD/$BRIEFING_SRC" ;; esac
  [ -f "$BRIEFING_SRC" ] || { echo "ERROR: briefing not found: $BRIEFING_SRC" >&2; exit 1; }
  if [ -e "$OUTPUT" ] && [ "$OUTPUT" -ef "$BRIEFING_SRC" ]; then
    echo "ERROR: output must not be the same file as the briefing" >&2; exit 1
  fi
fi

# Clear any stale output now, before the failure-prone setup below (missing
# dependency, -n rewrite, cd, run), so a failed invocation can never be mistaken
# for a prior success by an output-based caller.
: > "$OUTPUT" || { echo "ERROR: cannot write output: $OUTPUT" >&2; exit 1; }

command -v codex-fugu >/dev/null 2>&1 || {
  echo "ERROR: codex-fugu not found. Install: https://console.sakana.ai/get-started" >&2; exit 127; }

# --- Artifacts directory (the oracle's sanctioned place to write files) -----
# codex-fugu's -o captures only the final assistant message. If the oracle wants
# to emit files (patches, mockups, a long answer), they go here. The default sits
# next to -o; override with SUPER_ORACLE_ARTIFACTS_DIR. This dir is owned by the
# run: it is cleared and recreated each time, and removed at the end if empty.
# Because we rm -rf it, we NEVER clobber a path we don't own: we refuse obviously
# dangerous targets and refuse any existing dir that lacks our ownership marker,
# so a stray SUPER_ORACLE_ARTIFACTS_DIR can't delete a user's data.
ARTIFACTS_DIR="${SUPER_ORACLE_ARTIFACTS_DIR:-$OUTPUT.artifacts}"
case "$ARTIFACTS_DIR" in /*) ;; *) ARTIFACTS_DIR="$ORIGPWD/$ARTIFACTS_DIR" ;; esac
ARTIFACTS_DIR="${ARTIFACTS_DIR%/}"
OWN_MARKER=".super-oracle-owned"
case "$ARTIFACTS_DIR" in
  "" | "/" | "$HOME" | "$ORIGPWD" | "$WORKDIR" | "$OUTPUT")
    echo "ERROR: refusing to use artifacts dir '$ARTIFACTS_DIR' (unsafe: would delete a path the oracle doesn't own). Set SUPER_ORACLE_ARTIFACTS_DIR to a dedicated path." >&2; exit 1 ;;
esac
if [ -e "$ARTIFACTS_DIR" ] && [ ! -e "$ARTIFACTS_DIR/$OWN_MARKER" ]; then
  echo "ERROR: artifacts dir '$ARTIFACTS_DIR' already exists and isn't owned by super-oracle; refusing to delete it. Point SUPER_ORACLE_ARTIFACTS_DIR at a fresh path." >&2; exit 1
fi
# Hard-fail the clear: if a stale owned dir can't be removed, a leftover
# answer.md could later be recovered into -o as if it came from this run.
rm -rf "$ARTIFACTS_DIR" || { echo "ERROR: cannot clear artifacts dir: $ARTIFACTS_DIR" >&2; exit 1; }
mkdir -p "$ARTIFACTS_DIR" || { echo "ERROR: cannot create artifacts dir: $ARTIFACTS_DIR" >&2; exit 1; }
: > "$ARTIFACTS_DIR/$OWN_MARKER"
export SUPER_ORACLE_ARTIFACTS_DIR="$ARTIFACTS_DIR"

# --- Resolve permission posture (see header) -------------------------------
valid_sandbox() {
  case "$1" in read-only|workspace-write|danger-full-access) return 0 ;; *) return 1 ;; esac
}
if [ -n "${SUPER_ORACLE_BYPASS:-}" ] && [ "$SUPER_ORACLE_BYPASS" != "0" ] && [ "$SUPER_ORACLE_BYPASS" != "1" ]; then
  echo "ERROR: SUPER_ORACLE_BYPASS must be 0 or 1" >&2; exit 2
fi
POSTURE_ARGS=()
if [ -n "${SUPER_ORACLE_SANDBOX:-}" ]; then
  valid_sandbox "$SUPER_ORACLE_SANDBOX" || {
    echo "ERROR: SUPER_ORACLE_SANDBOX must be read-only, workspace-write, or danger-full-access" >&2; exit 2; }
  POSTURE_ARGS=(--sandbox "$SUPER_ORACLE_SANDBOX")
elif [ "${SUPER_ORACLE_BYPASS:-}" = "1" ]; then
  POSTURE_ARGS=(--dangerously-bypass-approvals-and-sandbox)
elif [ "${SUPER_ORACLE_BYPASS:-}" = "0" ]; then
  POSTURE_ARGS=(--sandbox workspace-write)
elif [ -n "${CODEX_SANDBOX:-}" ] || [ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" = "1" ]; then
  # Parent already sandboxed us. CODEX_SANDBOX is a backend marker (e.g.
  # "seatbelt"), not a --sandbox policy value, so treat it as a boolean signal
  # and stay conservative instead of escalating to a full bypass.
  POSTURE_ARGS=(--sandbox workspace-write)
else
  POSTURE_ARGS=(--dangerously-bypass-approvals-and-sandbox)   # unattended default
fi

# --- Progress heartbeat (keeps a long run feeling alive) -------------------
# Prints to stderr only, so it never contaminates -o. A clean, self-contained
# reassurance line every interval: the elapsed counter proves liveness, and the
# text explains the wait is normal — no raw log lines (which look like errors).
heartbeat() {
  local interval="$1" start now el mm ss sleep_pid="" wait_s
  # Show the first sign of life fast even when the interval is long, so the user
  # never stares at a silent terminal wondering whether it hung.
  wait_s="$interval"; [ "$interval" -gt 15 ] && wait_s=15
  # Run sleep as an explicit child and kill it on TERM. Otherwise killing this
  # subshell would orphan an in-progress `sleep`, which keeps inherited stderr
  # fds open and can make a stderr-draining caller hang for up to `interval`s.
  trap '[ -n "${sleep_pid:-}" ] && kill "$sleep_pid" 2>/dev/null; exit 0' TERM INT
  start=$(date +%s)
  while :; do
    sleep "$wait_s" & sleep_pid=$!
    wait "$sleep_pid"; sleep_pid=""
    wait_s="$interval"   # after the quick first beat, settle to the real cadence
    now=$(date +%s); el=$((now - start)); mm=$((el / 60)); ss=$((el % 60))
    echo ">> super-oracle: still working — ${mm}m${ss}s elapsed · Fugu Ultra runs take a few minutes, this is normal" >&2
  done
}
start_heartbeat() {
  [ "$PROGRESS_INTERVAL" -gt 0 ] || return 0
  heartbeat "$PROGRESS_INTERVAL" &
  HB_PID=$!
}
stop_heartbeat() {
  [ -n "${HB_PID:-}" ] || return 0
  kill "$HB_PID" 2>/dev/null
  wait "$HB_PID" 2>/dev/null
  HB_PID=""
}

# --- Optionally turn MCP off via a temp CODEX_HOME (only with -n) ----------
REAL_HOME="${CODEX_HOME:-$HOME/.codex}"; TMPHOME=""
cleanup() {
  stop_heartbeat
  [ -n "${TMPHOME:-}" ] && rm -rf "$TMPHOME"
  return 0
}
trap cleanup EXIT
if [ "$DISABLE_MCP" -eq 1 ] && [ -f "$REAL_HOME/config.toml" ]; then
  command -v python3 >/dev/null 2>&1 || {
    echo "ERROR: -n requires python3 to rewrite config.toml" >&2; exit 127; }
  TMPHOME="$(mktemp -d "${TMPDIR:-/tmp}/fugu-home.XXXXXX")"
  shopt -s dotglob nullglob 2>/dev/null || true
  for f in "$REAL_HOME"/*; do
    base="$(basename "$f")"; [ "$base" = "config.toml" ] && continue
    ln -sfn "$f" "$TMPHOME/$base"
  done
  shopt -u dotglob nullglob 2>/dev/null || true
  python3 - "$REAL_HOME/config.toml" "$TMPHOME/config.toml" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
skip = False; out = []
for line in open(src, encoding="utf-8").read().splitlines(keepends=True):
    m = re.match(r'^\s*\[\s*([A-Za-z0-9_.-]+)', line)
    if m:
        name = m.group(1)
        skip = name == "mcp_servers" or name.startswith("mcp_servers.")
    if not skip:
        out.append(line)
open(dst, "w", encoding="utf-8").write("".join(out))
PY
  export CODEX_HOME="$TMPHOME"
fi

run() {
  codex-fugu exec --ephemeral "${POSTURE_ARGS[@]}" --skip-git-repo-check \
    -c model="$MODEL" -o "$OUTPUT" -
}

# Output contract prepended to every briefing, so correctness never depends on
# the briefing author remembering how -o works.
emit_contract() {
  cat <<EOF
# Output contract (injected by super-oracle.sh — follow exactly)
Your caller saves ONLY your final assistant message. Put your full answer there.
Do NOT write the answer to a file and reply with just a pointer.
You MAY create supporting files (patches, mockups, long appendices), but ONLY in:
  $ARTIFACTS_DIR
If the answer is too large for one message, write it to $ARTIFACTS_DIR/answer.md
AND still put the verdict, key findings, and an "Artifacts" list (absolute paths)
in your final message.

--- briefing follows ---

EOF
}

[ -n "$WORKDIR" ] && cd "$WORKDIR"
[ "$DISABLE_MCP" -eq 1 ] && MCP_STATE="off" || MCP_STATE="on"
[ "$PROGRESS_INTERVAL" -gt 0 ] && PROGRESS_STATE="${PROGRESS_INTERVAL}s" || PROGRESS_STATE="off"
echo ">> super-oracle: model=$MODEL mcp=$MCP_STATE posture=${POSTURE_ARGS[*]} progress=$PROGRESS_STATE cwd=$(pwd) artifacts=$ARTIFACTS_DIR" >&2
# Human-friendly expectation setter, in case the technical line above scrolls out
# of a harness's small output window.
if [ "$PROGRESS_INTERVAL" -gt 0 ]; then
  echo ">> super-oracle: consulting Fugu Ultra — this usually takes a few minutes; progress every ${PROGRESS_INTERVAL}s, answer will be saved to $OUTPUT" >&2
else
  echo ">> super-oracle: consulting Fugu Ultra — this usually takes a few minutes; answer will be saved to $OUTPUT" >&2
fi

# Filter codex/MCP framework noise from displayed stderr so the user isn't greeted
# by a wall of scary-looking WARN/503 lines that have nothing to do with their
# question. We only drop codex-internal WARN namespaces and known-harmless MCP
# auth/shutdown chatter; real ERROR-level output and the oracle's own text still
# surface (and an empty answer is caught separately). --line-buffered is essential:
# without it grep block-buffers when its stdout is a pipe, so the oracle's output
# would clump at the very end instead of streaming live. (BSD/macOS and GNU both
# support it.)
FILTER='(MCP client during shutdown|OAuth authorization required|Token refresh not possible|Auth required|rmcp::transport|WARN codex_)'
# Escape hatch: the filter drops all `WARN codex_` lines, which in rare cases can
# hide a benign-looking but consequential notice (e.g. a model fallback off
# fugu-ultra, or context truncation) that still yields a non-empty answer and so
# slips past the empty-output check. Set SUPER_ORACLE_VERBOSE=1 to see raw stderr
# when an answer looks off. (cat reads/writes directly, so it still streams live.)
if [ "${SUPER_ORACLE_VERBOSE:-0}" = "1" ]; then
  GREP_LB=(cat)
else
  GREP_LB=(grep --line-buffered -Ev "$FILTER")
fi

# A misconfigured/expired MCP server can make codex-fugu exit non-zero even
# though the oracle answered fine. Judge success by whether output was produced,
# not by codex's exit code (so a broken MCP never breaks a good run).
RUN_START=$(date +%s)
set +e
start_heartbeat
if [ -n "$BRIEFING_SRC" ]; then
  { emit_contract; cat "$BRIEFING_SRC"; } | run 2> >("${GREP_LB[@]}" >&2)
else
  { emit_contract; cat; } | run 2> >("${GREP_LB[@]}" >&2)
fi
rc=$?
stop_heartbeat
# Deliberately stay with `set +e` for the rest of the script. The tail does its
# own explicit error handling (it exits 1 only on genuinely empty output), so
# re-enabling `set -e` here would add no safety and risks a spurious non-zero
# exit from a benign `[ test ] && echo` short-circuit on a successful run.

# Recover an oversized/file-only answer so a run is never silently wasted. Under
# set +e the write must be checked explicitly, or a failed/partial write could
# slip past the empty-output check below and exit 0 with a corrupt answer.
if [ ! -s "$OUTPUT" ] && [ -s "$ARTIFACTS_DIR/answer.md" ]; then
  if ! cat "$ARTIFACTS_DIR/answer.md" > "$OUTPUT"; then
    echo "ERROR: cannot recover answer from $ARTIFACTS_DIR/answer.md into $OUTPUT" >&2; exit 1
  fi
  echo ">> super-oracle: recovered answer from $ARTIFACTS_DIR/answer.md" >&2
fi

# List artifacts the oracle actually wrote (ignore our ownership marker).
# A missing dir means "no artifacts": the oracle can legitimately delete its own
# artifacts dir (it runs with our perms and sees $SUPER_ORACLE_ARTIFACTS_DIR), and
# a clean run wrote nothing worth keeping. Only a find failure on a dir that DOES
# exist (e.g. a permissions problem) is a real error worth aborting on.
if [ ! -d "$ARTIFACTS_DIR" ]; then
  ARTIFACT_FILES=""
elif ! ARTIFACT_FILES="$(find "$ARTIFACTS_DIR" -type f ! -name "$OWN_MARKER")"; then
  echo "ERROR: cannot list artifacts dir: $ARTIFACTS_DIR" >&2; exit 1
fi
if [ -z "$ARTIFACT_FILES" ] && [ -d "$ARTIFACTS_DIR" ]; then
  rm -rf "$ARTIFACTS_DIR" 2>/dev/null || true   # only the marker; don't litter
fi

if [ ! -s "$OUTPUT" ]; then
  echo "ERROR: oracle produced no final message (codex-fugu exit $rc; some MCP noise may have been filtered)." >&2
  [ -n "$ARTIFACT_FILES" ] && echo "ERROR: but it wrote files; inspect: $ARTIFACTS_DIR" >&2
  exit 1
fi

# Tell the caller what files exist so they read (and don't delete) them. If we
# can't record that artifacts exist, fail loudly rather than hide them.
if [ -n "$ARTIFACT_FILES" ]; then
  if ! { echo; echo "---"; echo "## Artifacts (read these; do not delete before reading)";
    printf '%s\n' "$ARTIFACT_FILES" | sed 's/^/- /'; } >> "$OUTPUT"; then
    echo "ERROR: cannot append artifact manifest to $OUTPUT (artifacts are in $ARTIFACTS_DIR)" >&2; exit 1
  fi
fi

[ "$rc" -ne 0 ] && echo ">> super-oracle: note: codex-fugu exited $rc (likely an MCP server issue); answer was still produced" >&2
TOTAL=$(( $(date +%s) - RUN_START )); echo ">> super-oracle: done in $((TOTAL / 60))m$((TOTAL % 60))s — answer in $OUTPUT" >&2
[ -n "$ARTIFACT_FILES" ] && echo ">> super-oracle: artifacts in $ARTIFACTS_DIR" >&2
exit 0   # never let a false test above become the script's exit status
