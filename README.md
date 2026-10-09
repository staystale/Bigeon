# Bigeon

A carrier pigeon for code. A strong model (the **foreman**, e.g. Claude) hands tasks to a cheap or local
model (the **worker**). The worker codes, runs your check, and sends back only `PASS` or `FAIL` plus the
first few error lines. The foreman reviews or fixes, and the loop repeats. Notes travel through git, so
there is no server and nothing to install except Node.

This work style is called the **Foreman Loop**. See [docs/foreman-loop.md](docs/foreman-loop.md).

## Why

- Expensive tokens go on thinking (planning, review, fixes), not typing.
- Only short results cross between machines: pass/fail plus ~20 error lines, never whole logs.
- Works with any language: the check is just a command that exits 0 or not.
- Zero dependencies. Node 18+ and git.

## Install

```
git clone <this repo> bigeon
cd your-project
node ../bigeon/bin/bigeon.mjs init
```

Or `npm link` inside the bigeon folder to get a global `bigeon` command.

## Configure

`bigeon init` creates `bigeon.config.json` in your project:

```json
{
  "checkCommand": "npm test",
  "errorLines": 20,
  "maxTries": 3,
  "pollSeconds": 30,
  "commsBranch": "agent-comms",
  "remote": "origin",
  "checkTimeoutSeconds": 300
}
```

`checkCommand` is anything: `npm test`, `pytest`, `make`, `dotnet build`, `node --check src/main.js`.

## Commands

| Command | Who | What |
|---|---|---|
| `bigeon check` | worker | Run `checkCommand`; print `PASS` or `FAIL` and the first N error lines |
| `bigeon send task --text "..."` | foreman | Send a task (also `--file`, or text on stdin). Ids are automatic |
| `bigeon watch tasks` | worker | Wait for a new task, print it, exit 0 |
| `bigeon report 001 --tries 2 --summary "..."` | worker | Run the check, write `results/001.md`, push it |
| `bigeon watch results` | foreman | Wait for a new result, print it |
| `bigeon send result 001 --text "..."` | either | Send a hand-written result |

`watch` exits with code 2 when `--once` or `--timeout MINUTES` runs out with nothing new. Polling is plain
git, so it costs no model tokens until a note arrives.

## Telling your agents

Each agent reads one role file. In your message to the agent (or in that machine's own `CLAUDE.md`), say:

- Foreman: `Read <path-to-Bigeon>/docs/FOREMAN.md and act as the foreman. Use bigeon in this project.`
- Worker: `Read <path-to-Bigeon>/docs/WORKER.md and act as the worker. Use bigeon in this project.`

The role files are [docs/FOREMAN.md](docs/FOREMAN.md) and [docs/WORKER.md](docs/WORKER.md).

## How it works

Notes live on a git branch (`agent-comms`) in a hidden worktree at `.bigeon/comms`, so your own branch and
working tree are never touched. The foreman writes only `tasks/`, the worker only `results/`, so they
never conflict. Code goes on normal branches as usual. See [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Test

```
npm test
```

Runs a full foreman/worker loop against a local bare git remote.

## Limits

- Git does not notify, so `watch` polls (default every 30 seconds).
- The check only catches what it tests.
- Do not put keys or tokens in notes. The comms branch is as public as the repo it lives in.

## License

MIT
