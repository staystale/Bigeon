# Bigeon protocol

Rules both agents follow. Keep notes short: they cost tokens every time they are read.

## Roles and ownership

- **Foreman** writes `tasks/NNN.md`. Never writes `results/`.
- **Worker** writes `results/NNN.md` and commits code on its own branch, e.g. `worker/NNN`. Never writes `tasks/`.
- One id links a task to its result (`tasks/001.md` is answered by `results/001.md`).

## Task note

```
Goal:       one or two sentences
Files:      files to touch
Done when:  which check must pass
Notes:      anything the worker must not break
```

## Result note (written by `bigeon report`)

```
Status:  PASS | FAIL
Commit:  short hash on the work branch
Tries:   attempts used
Errors:  first N lines (FAIL only)
Summary: two or three lines
```

## The loop

1. Foreman: `bigeon send task`.
2. Worker: `bigeon watch tasks`, read the task, code on a work branch.
3. Worker: `bigeon check`. If FAIL, fix and re-check, up to `maxTries`.
4. Worker: `bigeon report NNN --tries N --summary "..."`.
5. Foreman: `bigeon watch results`.
   - PASS and trivial: accept.
   - PASS and non-trivial: review the diff (`git diff main..worker/NNN`).
   - FAIL: read the errors, then send a fix or a clearer task.

## Token rules

- Send diffs, not whole files.
- Send the first N error lines, not full logs.
- Worker self-fixes before escalating. Foreman reviews only when the change is non-trivial or checks fail.

## Safety

- Never put keys, tokens or URLs with secrets in notes.
- The comms branch is pushed to the same remote as the code.
