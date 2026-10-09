# How we work with Bigeon

Our own setup and the lessons learned. The general docs are in [FOREMAN.md](FOREMAN.md),
[WORKER.md](WORKER.md) and [PROTOCOL.md](PROTOCOL.md).

## Machines

| Role | Machine | Runs |
|---|---|---|
| Foreman | Laptop (`C:\Users\Admin`) | The foreman agent. Sends tasks with `bigeon send task`, waits with `bigeon watch results` |
| Worker | `billj@192.168.1.13` | `bigeon worker` in a visible terminal, so the human can watch. It starts the Cline CLI for each task |
| Human | Either | Sets the goal, approves major steps, keeps the worker window open |

## How the two sides talk

They never talk to each other directly. Both push to and pull from one shared git remote (`origin`):

```
 foreman clone  --push task-->  origin  <--pull, every pollSeconds--  worker clone
 foreman clone  <--pull------   origin  <--push result--------------  worker clone
```

- **Notes** live on the `agent-comms` branch, in a hidden worktree at `.bigeon/comms`.
  The foreman writes only `tasks/NNN.md` and the worker writes only `results/NNN.md`, so they never conflict.
- **Code** goes on normal branches. The worker pushes `worker/NNN`, and the foreman reviews it with
  `git fetch` then `git diff main..origin/worker/NNN`.
- **Both sides pull.** `watch` is "pull, look, sleep, repeat", and polling costs no model tokens.

## Target: GitHub only

For real projects (e.g. car sim), `origin` is a GitHub repo and both machines clone it the normal way.
Each machine needs its own push access to GitHub (Git Credential Manager sign-in or an SSH key).
Never put tokens in notes, config or commits.

## Test setup (used to prove Bigeon itself)

While testing, the shared remote was a bare repo **on the worker PC**:

- Remote: `C:\Users\billj\work\bigeon-test.git`
- Worker clone: `C:\Users\billj\work\bigeon-test-worker` (uses the remote through its local disk)
- Foreman clone: `C:\Users\Admin\AppData\Local\Temp\bigeon-test-foreman` (uses the remote over SSH:
  `billj@192.168.1.13:C:/Users/billj/work/bigeon-test.git`)

### Gotcha: SSH remote on a Windows machine whose SSH shell is cmd.exe

Over SSH, git runs `git-upload-pack '<path>'` (fetch/pull) or `git-receive-pack '<path>'` (push) on
the other machine. `cmd.exe` does not treat single quotes as quotes, so it looks for a folder literally
named `'C:/...'` and fails:

```
fatal: ''C:/Users/billj/work/bigeon-test.git'' does not appear to be a git repository
```

Fix: in the clone that connects over SSH, tell git to start those helpers through PowerShell, which
handles the quotes properly. This is a local setting, so the worker machine does not change:

```
git config remote.origin.uploadpack "powershell git-upload-pack"
git config remote.origin.receivepack "powershell git-receive-pack"
```

Undo with `git config --unset remote.origin.uploadpack` (and the same for `receivepack`).
None of this is needed when `origin` is GitHub.

Bigeon 0.1.0 did not report this failure: `watch` kept polling as if nothing had arrived.
Fixing that is on the to-do list (pull errors must be reported, not swallowed).

## Habits

- One small task at a time. Every task names its file(s) and its "done when" check.
- The task text and the worker's `checkCommand` must agree. Tasks 004 and 005 failed only because the
  task asked for "goodbye G" while the check expected "hello G bigeon test 2".
- The foreman checks each claim the worker makes (e.g. reads the file over SSH) instead of trusting the summary.
- Bulk work goes to the worker. The foreman plans, reviews and makes the hard fixes.
