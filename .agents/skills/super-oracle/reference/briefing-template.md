# Super Oracle Briefing Template

Fill every section, delete the parenthetical guidance, then run the script next
to this skill: `bash <this-skill-dir>/scripts/super-oracle.sh -o OUTPUT.md
BRIEFING.md`. The oracle has no prior context, so be complete and specific.

---

# Task: <one-line goal>

You are codex-fugu acting as a rigorous second-opinion oracle. Be skeptical,
concrete, and evidence-driven. Do not flatter.

## Working directory
`/abs/path/to/repo`

## Context
- What this project is and what I am trying to achieve.
- What I have already done, tried, or ruled out (do not repeat it).
- Domain constraints, prior decisions, or style rules to respect.

## Read these first
- `/abs/path/file1` — why it matters
- `/abs/path/file2` — why it matters
- PR URLs, command outputs, logs, data files as relevant

## The question (sharp and singular)
<Exactly what you want answered.>

## Constraints / non-goals
- Do / do not modify files. (Say which.)
- Stay within <scope>; do not expand search beyond <X>.
- Respect <style guide / invariants / API contracts>.

## You may fan out
Spawn your own subagents to read files in parallel or verify sources. Verify
load-bearing claims before reporting them.

## Output
Put the full answer in your final message (the script injects an output contract
saying so; any supporting files go only in the artifacts dir it names). Lead with
a one-line verdict (SHIP / DO NOT SHIP, PASS / FAIL). Then a table of findings:
location (`file:line`), issue, severity, exact fix. Quote evidence verbatim. End
with explicit uncertainties and what you could not verify.
