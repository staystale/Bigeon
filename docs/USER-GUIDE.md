# Bigeon user guide

## What it is

Bigeon lets a strong AI on one machine (the **foreman**, e.g. Claude) hand coding tasks to a cheaper AI on another
machine (the **worker**, e.g. Cline), through git. The worker does the task, runs your tests and reports PASS or FAIL.
The foreman checks the work and merges it.

Only short notes travel, on the `agent-comms` branch of your project's repo: the task text and the result.
Never put passwords, keys or tokens in a task: notes are as public as the repo. Your AI's API key stays in that AI's
own settings on the worker; Bigeon never reads it.

In the commands below:

- `<Bigeon>` is the folder where you cloned Bigeon, e.g. `C:\Users\you\work\Bigeon`.
- `<project>` is your project's clone on that machine, e.g. `C:\Users\you\work\myproject`.
- If you ran `npm link` in `<Bigeon>`, you can type `bigeon` instead of `node <Bigeon>/bin/bigeon.ts`.

## The machines and their windows

**Worker machine**

- **The worker window**: the terminal where the worker loop runs. Do not type commands in it. Only press Ctrl+C
  there (stop), or Esc (if it is paused, see section 7).
- **A second terminal** (PowerShell on Windows): for every other command marked *worker machine*.

**Foreman machine**

- **Your AI assistant** (e.g. Claude Code), opened in `<project>`. It runs the bigeon commands for you.
- **A terminal** in `<project>`: only if you want to run bigeon commands yourself (section 5).

Foreman and worker can be the same machine, in two different folders.

## 1. Set up (once per machine)

*Worker machine and foreman machine, terminal:*

    git clone https://github.com/staystale/Bigeon.git
    cd <project>
    node <Bigeon>/bin/bigeon.ts init

`init` creates `bigeon.config.json` in `<project>` (never committed) and adds it and `.bigeon/` to `.gitignore`.
Open that file and set:

- `checkCommand`: the command that tests your project, e.g. `npm run verify` or `pytest`. Exit 0 means PASS.
- On the worker only, `workerCommand`: how to start the AI agent. It gets the task on its input. For the Cline CLI:

      "workerCommand": "cline --auto-approve true --timeout 600 \"The task and rules are provided on stdin. Carry out that task now, following the rules.\""

Test it: `node <Bigeon>/bin/bigeon.ts check` must print PASS or FAIL.

## Keep the conversation private (optional)

1. On GitHub create a new, empty, private repo (no README).
2. Both machines: check `git ls-remote <its URL>` works.
3. Both machines: set `"commsRepo": "<its URL>"` in `bigeon.config.json`, then restart the worker loop.

Then tasks, results and status go only to that repo; the project repo only gets code.

## Start the conversation fresh (wipe)

1. Stop the worker loop (Ctrl+C in the worker window).
2. Worker machine and foreman machine, terminal in `<project>`: `node <Bigeon>/bin/bigeon.ts wipe`
   (type `wipe` to confirm, or add `--yes`). Do it on both machines: a machine that still has the old notes would push them back.
3. Start the worker loop again.

Old copies GitHub already served may stay cached for a while; the deleted commits are not visible on the repo any more.

## 2. Start the worker

*Worker machine, a new terminal (this becomes the worker window):*

    cd <project>
    node <Bigeon>/bin/bigeon.ts worker

- It prints `Bigeon <version> (up to date)`, then waits for a task. Leave the window open.
- It costs nothing while it waits; the agent only starts when a task arrives.
- If the Cline desktop app is open on the worker machine, quit it first, including its background service
  `code-sidecar.exe`. Otherwise the cline command hands its work to that service, outside Bigeon's guard, and
  programs the agent starts can keep running after it.

**Optional: a start script.** Save the start commands as a file you can double-click, or ask your AI assistant to make
one for your folders. Windows, `Start Bigeon worker.cmd`:

    @echo off
    cd /d <project>
    node <Bigeon>\bin\bigeon.ts worker
    pause

Linux/macOS, `start-bigeon-worker.sh` (then `chmod +x start-bigeon-worker.sh`):

    #!/bin/sh
    cd <project> && node <Bigeon>/bin/bigeon.ts worker

## 3. Stop or update the worker

**Stop.** *Worker machine, worker window:* press Ctrl+C. It also stops the agent and tells the foreman it stopped.

**Update.** When the worker window says `UPDATE AVAILABLE` (the foreman's `status` shows it too). Bigeon never
updates itself:

1. *Worker window:* press Ctrl+C.
2. *Worker machine, terminal:*

       cd <Bigeon>
       git pull

3. Start the worker again (section 2). It should now say `(up to date)`.

## 4. Start the foreman

*Foreman machine, terminal in `<project>`:* check the worker is alive:

    node <Bigeon>/bin/bigeon.ts status

Then open your AI assistant in `<project>` and tell it:

    Read <Bigeon>/docs/FOREMAN.md and act as the foreman. Use bigeon in this project.

From then on, tell it what you want done. It writes the tasks, waits for results, checks the work and merges it.

## 5. Commands

*Foreman machine, terminal in `<project>`.* Your AI foreman normally runs these for you.

- `node <Bigeon>/bin/bigeon.ts status`
  Is the worker idle, working or down? Also shows its Bigeon version and whether it needs an update.
  Exit 0 alive, 2 no status yet, 4 stopped or down.
- `node <Bigeon>/bin/bigeon.ts send task --file task.md`
  Send a task (ids are automatic). `--text "..."` for a short one.
- `node <Bigeon>/bin/bigeon.ts watch results --timeout 30`
  Wait up to 30 minutes for the next result, checking git every 30 seconds (no AI tokens used).
  `--once` checks once, now. Exit 0 got one, 2 nothing yet, 3 remote unreachable.
- `node <Bigeon>/bin/bigeon.ts accept 41 --dry-run`
  Show what merging task 041 would do. Without `--dry-run` it pushes `worker/041` to main, but only if the result
  is PASS, the branch is unchanged since, it is based on the current main and GitHub's check passed (waits up to
  15 min). Exit 0 done, 1 refused (says why), 3 remote unreachable, 5 check still running.
  Look at the change first: `git fetch origin` then `git diff origin/main origin/worker/041`.

*Either machine, terminal in `<project>`:*

- `node <Bigeon>/bin/bigeon.ts version`: this machine's Bigeon version, and whether an update is available.
- `node <Bigeon>/bin/bigeon.ts check`: run `checkCommand`, print PASS or FAIL and the important lines.
- `node <Bigeon>/bin/bigeon.ts wipe`: delete all tasks, results and status (asks first; `--yes` skips the question). See "Start the conversation fresh (wipe)".

## 6. Reading a result

    Status:  PASS or FAIL, from the loop's own check (not the agent's word)
    Commit:  the commit the worker ended on
    Tries:   attempts used
    Errors:  (FAIL only) the lines around the failure
    Summary: how the agent ended, e.g. "worker agent exit 0"
    Base:    the main commit the work started from. "WARNING N commit(s) behind": do not accept, send it again
    Dirty:   files left uncommitted in the worker's folder (reported only, never touched)
    Stashed: leftovers from a crashed run were set aside (see section 7)
    Worker said: the agent's last lines


## 7. When something goes wrong

- **The worker window's title starts with "Select"** (Windows). *Worker window:* press Esc. Clicking in a console
  window selects text and pauses the program in it.
- **`status` says "seems down" or "stopped".** *Worker machine:* look at the worker window. If it is closed, start
  the worker (section 2).
- **"another bigeon worker is already running in this folder".** *Worker machine:* a loop is already open there.
  Close the other worker window first.
- **`status` says "no worker status yet".** The worker runs an old Bigeon: update it (section 3).
- **A result says `Base: ... WARNING ... behind`.** Do not accept it; send the same task again.
- **`accept` refused.** Read its one-line reason; fix that, or send a new task.
- **"cannot reach origin".** Check the network or your GitHub sign-in. The loop keeps retrying by itself.
- **Programs left running after a task** (Windows). *Worker machine, PowerShell:*

      Get-CimInstance Win32_Process -Filter "name='node.exe'" | Select-Object ProcessId, CommandLine

  Only the `bigeon.ts worker` line should be there. If there are more, check the Cline desktop app is closed (section
  2), and stop an extra one with `Stop-Process -Id <ProcessId>`.
- **Work lost after a crash.** Nothing is ever deleted. *Worker machine, terminal in `<project>`:* `git stash list`,
  then `git stash apply stash@{0}`.

## 8. What keeps it safe

- One worker loop per folder.
- A task that crashes the loop more than `maxTries` times is reported as FAIL, not retried forever.
- The agent runs under a guard (a Job Object on Windows, a watched process group elsewhere): when the agent finishes
  or the loop stops, the agent and everything it started are stopped within about a second.
- Only the foreman moves code to main, and `accept` refuses anything unchecked or out of date.

## 9. Settings (`bigeon.config.json`)

- `checkCommand`: what decides PASS (exit 0) or FAIL.
- `workerCommand`: worker only. How the agent is started (it gets the task on its input).
- `pollSeconds` (default 30): how often git is checked.
- `maxTries` (3): attempts per task.
- `errorLines` (20): lines shown on FAIL.
- `heartbeatMinutes` (10): how often the worker tells the foreman it is alive (0 = off).
- `checkTimeoutSeconds` (300): stop a stuck check after this.
- `workerTimeoutSeconds` (900): stop a stuck agent after this.
- `remote`, `commsBranch` (origin, agent-comms): where the notes travel.
- `commsRepo` (empty): a separate repo for the notes, e.g. a private one. Empty = the project's own repo.

