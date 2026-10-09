# Using the Cline CLI as the worker

The worker must run shell commands with nobody at the keyboard, so use the Cline **CLI**, not the VS Code extension.
Commands below come from Cline's CLI docs (https://docs.cline.bot/cline-cli/overview). Check `cline --help`, since flags can change.

## Install and sign in (once, on the worker machine)

```
npm i -g cline
cline auth
```

`cline auth` sets the provider and model. A local model (Ollama or LM Studio) or a cheap hosted one both work.

## Run one worker pass

From inside the project folder:

```
cline --auto-approve true --timeout 900 "Read <path-to-Bigeon>/docs/WORKER.md and act as the worker. Use bigeon in this project. Handle one task, then stop."
```

- `--auto-approve true` lets it run commands and edit files without asking. It is the default, but say it explicitly.
  This is powerful: use a clean branch, a project folder you can afford to reset, and never a folder holding secrets.
- `--timeout 900` stops a stuck run after 15 minutes.
- `-c <path>` sets the working directory if you are not already in it.
- `-P <provider> -m <model>` override the provider and model for one run.

## Keep it looping (recommended: `bigeon worker`)

Set `workerCommand` in the project's `bigeon.config.json`, for example
`cline --auto-approve true --timeout 600 "The task and rules are provided on stdin. Carry out that task now, following the rules."`,
then run this in the project folder and leave the window open:

```
node <path-to-Bigeon>/bin/bigeon.ts worker
```

It waits for a task (no tokens), starts Cline with the task on stdin, runs the check, retries up to
`maxTries`, and pushes the result note itself, so a result always goes back even if Cline crashes.

### Alternative: a shell loop

A Cline run ends when its task ends, so without `bigeon worker` the loop needs something outside it.
A small shell loop that starts one pass at a time and sleeps when there is no task works too. In PowerShell:

```
while ($true) {
  $task = bigeon watch tasks --timeout 10
  if ($LASTEXITCODE -eq 0) {
    cline --auto-approve true --timeout 900 "Read <path-to-Bigeon>/docs/WORKER.md and act as the worker. A new task has arrived. Skip the watch step and do this task, then check and report:`n$task"
  }
}
```

`bigeon watch` costs no model tokens, so the model only runs when a task has really arrived.
The loop passes the task text straight into the prompt, because `watch` marks a note as seen once it prints it.

## Cautions

- Test with a throwaway repo first.
- Keep `maxTries` small so a confused worker escalates instead of burning tokens.
- Do not let the worker push to `main`. Its role file says to use `worker/NNN` branches.
