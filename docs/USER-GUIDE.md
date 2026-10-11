# Bigeon user guide

Bigeon lets a strong AI (the **foreman**, e.g. Claude) hand coding tasks to a cheaper AI (the **worker**, e.g. Cline)
through git. Only short notes travel: the task, then PASS or FAIL with a few lines. Notes live on the `agent-comms`
branch of your project's repo. Never put passwords, keys or tokens in notes: they are as public as the repo.

In the commands below, `<Bigeon>` is the folder where Bigeon is cloned and `<project>` is the clone of your project.
If you ran `npm link` in the Bigeon folder you can type `bigeon` instead of `node <Bigeon>/bin/bigeon.ts`.

## 1. Set up a machine (once)

    git clone https://github.com/staystale/Bigeon.git
    cd <project>
    node <Bigeon>/bin/bigeon.ts init

`init` creates `bigeon.config.json` (not committed) and adds it and `.bigeon/` to `.gitignore`.
Set `checkCommand` in it (e.g. `npm run verify`, `pytest`). On the worker also set `workerCommand`, e.g.:

    "workerCommand": "cline --auto-approve true --timeout 600 \"The task and rules are provided on stdin. Carry out that task now, following the rules.\""

Then test: `node <Bigeon>/bin/bigeon.ts check` must print PASS or FAIL.

## 2. Start a session

Worker machine (leave this window open):

    cd <Bigeon>
    git pull
    cd <project>
    node <Bigeon>/bin/bigeon.ts worker

- `git pull` updates Bigeon. Do it, then restart the loop, whenever Bigeon changes.
- The loop costs nothing while it waits; the agent only starts when a task arrives.
- Stop it with Ctrl+C: it also stops the agent and marks itself "stopped".
- "another bigeon worker is already running in this folder": close the other loop window first.
- If the Cline desktop app is open on the worker, quit it (and its background service code-sidecar.exe) while the loop runs: the cline command then hands its work to that service, outside Bigeon's guard, so processes the agent starts can outlive it.
- The loop prints the Bigeon version when it starts and says "UPDATE AVAILABLE" when there is one. To update: Ctrl+C, `git pull` in `<Bigeon>`, start it again. Bigeon never updates itself.
- `bigeon status` on the foreman shows the same (the `Update:` line).

Foreman machine, check the worker is alive, then start the foreman:

    cd <project>
    node <Bigeon>/bin/bigeon.ts status

Tell the foreman AI: `Read <Bigeon>/docs/FOREMAN.md and act as the foreman. Use bigeon in this project.`

## 3. Commands

| Command | Who | What it does |
|---|---|---|
| `status` | foreman | Is the worker idle, busy or down? Shows the Bigeon version it runs. Exit 0 alive, 2 no status yet, 4 stopped or down |
| `send task --text "..."` | foreman | Send a task (ids are automatic). `--file task.md` for long ones |
| `watch results --timeout 30` | foreman | Wait up to 30 min for a result, checking git every 30 s (no tokens). Exit 0 got one, 2 nothing yet, 3 remote unreachable |
| `watch results --once` | foreman | Check once, now |
| `accept 41 --dry-run` | foreman | Show what accepting task 041 would do, without pushing |
| `accept 41` | foreman | Push `worker/041` to main, only if: result PASS, branch unchanged since the result, based on the current main, and GitHub's check passed (waits up to 15 min). Exit 0 done, 1 refused (says why), 3 remote unreachable, 5 check still running |
| `check` | either | Run `checkCommand`, print PASS or FAIL and the important lines |
| `version` | either | Show this machine's Bigeon version and say when an update is available. Exit 0 |
| `worker` | worker | The loop: wait, run the agent, check, retry up to `maxTries`, report |

Before accepting, look at the change: `git fetch origin` then `git diff origin/main origin/worker/041`.

## 4. Reading a result

    Status:  PASS or FAIL, from the loop's own check (not the agent's word)
    Commit:  the commit the worker ended on
    Tries:   attempts used
    Errors:  (FAIL only) the lines around the failure
    Summary: how the agent ended, e.g. "worker agent exit 0"
    Base:    the main commit the work started from. "WARNING N commit(s) behind": do not accept, send the task again
    Dirty:   files left uncommitted in the worker's folder (reported only, never touched)
    Stashed: leftovers from a crashed run were set aside (worker machine: git stash list)
    Worker said: the agent's last lines

## 5. When something goes wrong

| You see | Do this |
|---|---|
| `status` says "seems down" or "stopped" | Start the loop on the worker machine |
| `status` says "no worker status yet" | The worker runs an old Bigeon: `git pull` in `<Bigeon>` there, restart the loop |
| `Base: ... WARNING ... behind` | Do not accept; send the same task again from the current main |
| `accept` refused | Read its one-line reason; fix that, or send a new task |
| "cannot reach origin" | Check the network or GitHub sign-in; the loop keeps retrying on its own |
| Work lost after a crash? | On the worker: `git stash list`, then `git stash apply stash@{0}`. Nothing is ever deleted |

## 6. What keeps it safe

- One worker loop per folder.
- A task that crashes the loop more than `maxTries` times is reported as FAIL, not retried forever.
- The agent runs under a guard (a Job Object on Windows, a watched process group elsewhere): when the loop stops,
  the agent and everything it started is killed within about a second.
- Only the foreman moves code to main, and `accept` refuses anything unchecked or out of date.

## 7. Settings (`bigeon.config.json`)

| Setting | Default | Meaning |
|---|---|---|
| `checkCommand` | | What decides PASS (exit 0) or FAIL |
| `workerCommand` | | Worker only: how the agent is started (it gets the task on stdin) |
| `pollSeconds` | 30 | How often git is checked |
| `maxTries` | 3 | Attempts per task |
| `errorLines` | 20 | Lines shown on FAIL |
| `heartbeatMinutes` | 10 | How often the worker says it is alive (0 = off) |
| `checkTimeoutSeconds` | 300 | Stop a stuck check after this |
| `workerTimeoutSeconds` | 900 | Stop a stuck agent after this |
| `remote`, `commsBranch` | origin, agent-comms | Where the notes travel |
