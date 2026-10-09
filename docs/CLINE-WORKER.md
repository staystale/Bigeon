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

## Keep it looping

A Cline run ends when its task ends, so the loop needs something outside it. Simplest is a small shell loop
that starts one pass at a time and sleeps when there is no task. In PowerShell:

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
