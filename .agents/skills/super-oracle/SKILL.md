---
name: super-oracle
description: "Consult codex-fugu (Sakana Fugu Ultra, an ensemble of frontier models) as a second-opinion oracle for deep code review, hard cross-file debugging, architecture and refactor planning, and research synthesis. Use like a built-in oracle when you want a stronger reasoning model than the main agent. Triggers on: super oracle, codex-fugu, fugu ultra, deep review, second opinion."
---

# Super Oracle (codex-fugu / Fugu Ultra)

A second-opinion oracle for hard reasoning — code review, multi-file debugging,
architecture decisions, and research synthesis. It runs on **Sakana Fugu Ultra**
(a learned orchestrator over frontier models) via the **`codex-fugu` CLI**, so it
is not wired into your harness. You drive it with a file protocol: write a
self-contained briefing, run the script, read the markdown answer. Treat its
output as advice and verify load-bearing claims.

Use it for the hard 10% (subtle correctness, architecture, "what am I missing").
Do not use it for file reads, searches, or routine edits — do those directly.

## Invoke

Run the script that ships next to this `SKILL.md` (use its absolute path — the
agent's cwd is the user's repo, not the skill dir):

```bash
bash <this-skill-dir>/scripts/super-oracle.sh -o /abs/path/oracle-out.md /abs/path/briefing.md
```

Then read the output file and act on it. The script forces Fugu Ultra, leaves
your MCP servers on, and picks an unattended permission posture automatically
(see below). For pure review/advice runs, prefer `SUPER_ORACLE_SANDBOX=read-only`.

Because a run takes minutes, the script keeps you informed on stderr: a startup
line that says it is consulting Fugu Ultra and will take a few minutes, an
elapsed-time heartbeat every 30s (first one within ~15s so it never looks hung),
and a `done in Xm Ys` line at the end. Change the cadence with `-p SECONDS` or
`SUPER_ORACLE_PROGRESS_INTERVAL`; `-p 0` turns it off. All of this goes to stderr
only and never touches the `-o` answer.

## Write a good briefing (this determines quality)

The oracle has **zero prior context**. A terse prompt yields generic output.
Include: the goal and your role for it; the absolute working dir; files/PRs to
read first; the one sharp question; what you already ruled out; constraints and
non-goals; and the expected output shape (verdict first, then findings with
`file:line` and exact fixes, demanding verbatim evidence). Tell it that it may
spawn its own subagents to parallelize. See `reference/briefing-template.md`.

## Foot-guns (the reasons this script exists)

- **Always Fugu Ultra.** `codex-fugu` defaults to plain `fugu` on a stock
  install. The script forces `-c model=fugu-ultra`; do not drop it.
- **MCP is left on by default.** Unauthenticated MCP servers print harmless
  `Auth required` warnings at shutdown but do not block; measured overhead is a
  couple of seconds, immaterial for a long-running oracle. The script filters
  that cosmetic noise. Pass `-n` to turn MCP off only if a server genuinely
  hangs. Note: `-c mcp_servers="{}"` does NOT disable MCP in `exec` mode (codex
  deep-merges); `-n` strips `[mcp_servers.*]` via a temp `CODEX_HOME` instead.
- **Success = output produced, not exit code.** A broken/expired MCP server can
  make `codex-fugu` exit non-zero even when the oracle answered fine. The script
  judges success by whether the `-o` file is non-empty, so a bad MCP never breaks
  a good run; read the output file, don't gate on the exit code.
- **Fugu Ultra is slow.** Deep orchestration takes minutes. Do not wrap in
  `timeout` (absent on macOS); let it finish.
- **Fresh context every call.** Re-supply everything; there is no cross-call
  memory.
- **Noisy framework warnings are filtered** so the run reads clean. If an answer
  looks wrong or oddly short, re-run with `SUPER_ORACLE_VERBOSE=1` to see raw
  stderr (catches the rare case of a silent model fallback or context truncation).
- **Permission posture is approximated, not inherited.** codex does not expose
  the parent agent's approval/sandbox policy to child processes. The script uses
  `SUPER_ORACLE_SANDBOX` if set; else stays conservative (`--sandbox
  workspace-write`) when it detects a Codex sandbox signal (`CODEX_SANDBOX` /
  `CODEX_SANDBOX_NETWORK_DISABLED`); else defaults to
  `--dangerously-bypass-approvals-and-sandbox` for unattended use. Force with
  `SUPER_ORACLE_BYPASS=0|1`. For review-only runs use `SUPER_ORACLE_SANDBOX=read-only`.

## Consume the output

Read the answer, verify the load-bearing claims, apply must-fixes, weigh
optionals, reject what is wrong. For an approval loop, fix then re-run a short
confirmation briefing. Keep briefing/answer files (date-stamped) as an audit trail.

**Artifacts.** The oracle may emit supporting files (patches, mockups, a long
appendix) into an artifacts dir; the script appends a manifest of them to the
answer. Read those files before acting and do not delete them until you have. The
dir defaults to `OUTPUT.artifacts/` next to your `-o` file, so if `-o` is inside
your repo the artifacts are too; put `-o` under `/tmp` or set
`SUPER_ORACLE_ARTIFACTS_DIR` to keep them out of the repo. Inside your repo the
script only writes `-o` and that dir (with `-n` it also makes a temp `CODEX_HOME`
under `/tmp`, removed on exit).
