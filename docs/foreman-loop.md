# The Foreman Loop

A work style for coding with AI agents, and the idea Bigeon is built for.

## The idea

A strong, expensive model (the **foreman**) plans, reviews and fixes hard problems, but does not do the
bulk typing. A cheap or local model (the **worker**) writes the code, runs the checks, and reports back
only "passed" or "failed, here is the error". They never talk directly. They pass short notes through git
using Bigeon, and the loop repeats until the check is green.

## Why

- Expensive tokens go on thinking (planning, review, fixes), not typing.
- The worker handles the repetitive write, check, fix cycle for free or cheap.
- Only short results travel: pass/fail plus a few error lines, or a diff. Never whole files or full logs.
- Git is already installed, keeps history, and needs no extra service.

## Roles

- **Foreman**: writes task notes, reads short results, reviews non-trivial changes, writes the fix when the worker is stuck.
- **Worker**: reads tasks, writes code on a work branch, runs the check, reports, retries 2 to 3 times before asking for help.
- **Human**: sets the goal and approves large changes.

## The loop

1. Foreman sends a task.
2. Worker picks it up and codes.
3. Worker runs the check and fixes failures itself, up to `maxTries`.
4. Worker reports PASS or FAIL with the first few error lines.
5. Foreman accepts, reviews the diff, or sends a fix. Repeat.

## Token-saving rules

- Send diffs, not whole files.
- Send the first N error lines, not the full log.
- The worker self-fixes first. Escalate only after repeated failures.
- Review only when the change is non-trivial or the check fails.

## Limits

- Git does not notify, so `bigeon watch` polls.
- A round trip is a push plus a pull: seconds, not instant.
- The check only catches what it tests.
- If both machines share a network and speed matters more, SSH can run the check directly and return the output.

## Related tools

Bigeon does not replace these; it fills the gap between them:
Aider (architect mode), Roo Code (Orchestrator mode), Claude Code subagents, LiteLLM, claude-code-router.
Bigeon adds a foreman on one machine and a worker on another, handing off through git.

See [PROTOCOL.md](PROTOCOL.md) for the note formats and rules.
