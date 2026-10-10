# How we work with Bigeon

Our own setup. The general rules are in [FOREMAN.md](FOREMAN.md), [WORKER.md](WORKER.md) and
[PROTOCOL.md](PROTOCOL.md); this file says how we apply them.

## Principles

- **Token light.** The foreman plans, writes short task notes, reviews diffs and makes hard fixes.
  The worker does the typing, runs the checks and retries. Only short notes travel.
- **Git is the only channel.** Foreman and worker talk only through task and result notes on the
  project's GitHub repo. No SSH or local network is needed for the loop.
- **Polling is free.** `bigeon watch` (foreman) and `bigeon worker` (worker) are plain scripts that
  pull git and sleep. A model only runs when a note has really arrived.
- **The human decides.** The foreman asks the human before the first task on any repo, and before
  every major step or design decision.

## Machines

| Role | Machine | Runs |
|---|---|---|
| Foreman | Laptop (`C:\Users\Admin`) | Foreman agent. `bigeon send task`, `bigeon watch results`, reviews, moves passing work to `main` |
| Worker | Worker PC (`C:\Users\billj`) | `bigeon worker` in a visible terminal so the human can watch. It starts the Cline CLI for each task |
| Human | Either | Sets the goal, approves major steps, keeps the worker window open |

## Any repo works

Bigeon is not tied to one project. Point it at any git repo by running it **inside a clone of that repo**:
the notes go on that repo's `agent-comms` branch and the code on its `worker/NNN` branches.
The Bigeon tool itself lives in its own folder and is never edited by the worker.

```
C:\...\Bigeon          the tool (git pull to update, never edited by the worker)
C:\...\<project>       a clone of the project; bigeon.config.json lives here (not committed)
```

Before the first task on a new repo, the foreman confirms with the human:
which repo, which `checkCommand`, and that the worker loop is running in a clone of that repo.

Use a **private** repo when the notes or code should not be public: the `agent-comms` branch is as
visible as the repo. Never put keys or tokens in notes, config or commits.

## Set up a project (once per machine)

Both machines: Node 22.18+ (we use 24), git, and a GitHub sign-in that can push to the repo.

Worker PC:
```
cd C:\Users\billj\work
git clone https://github.com/<owner>/<project>.git
cd <project>
node ..\Bigeon\bin\bigeon.ts init
git config user.name bigeon-worker
git config user.email worker@example.invalid
```
Then set `checkCommand` and `workerCommand` in `bigeon.config.json`, for example:
```json
{
  "checkCommand": "npm run verify",
  "workerCommand": "cline --auto-approve true --timeout 600 \"The task and rules are provided on stdin. Carry out that task now, following the rules.\"",
  "pollSeconds": 30,
  "maxTries": 3
}
```

Laptop: clone the same repo, run `node <path-to-Bigeon>\bin\bigeon.ts init`, and set the same `checkCommand`.

## Run the loop

Worker PC, in the project clone (leave the window open):
```
node ..\Bigeon\bin\bigeon.ts worker
```
After Bigeon itself is updated (`git pull` in the Bigeon folder), restart it: Ctrl+C, then the same command. Only one loop can run per folder; if it says another worker is already running, close that window first.

Foreman, in its project clone:
```
bigeon send task --text "Goal: ... Files: ... Done when: ... Never push to main."
bigeon watch results --timeout 20
```

## Getting code onto main

`main` on GitHub has a rule: it only accepts commits that GitHub's own `verify` check has passed
(plus no force pushes and no deleting). So:

1. The worker pushes `worker/NNN` and reports PASS or FAIL.
2. GitHub runs the check on `worker/NNN` (a minute or two).
3. The foreman reviews `git diff origin/main origin/worker/NNN`.
4. If it is good and green, the foreman moves it with `bigeon accept NNN`. It checks the result note,
   that the branch is on top of main and the CI result, then pushes the commit to main.
   GitHub still refuses the push if the check did not pass.

## Habits

- One small task at a time. Every task names its files, its "done when" check, and "Never push to main".
- The task text and the worker's `checkCommand` must agree, or a correct worker still reports FAIL.
- The foreman checks the worker's claims (the diff, GitHub's check) instead of trusting the summary.
- Worker PC quirk: PowerShell blocks `npm.ps1`, so tasks say `npm.cmd` instead of `npm`.
- Stop and ask the human before moving on to a new project.
