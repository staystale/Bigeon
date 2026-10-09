// Bigeon worker loop: wait for a task, hand it to the worker agent (visible in this terminal),
// run the check, and send the result back. Reporting is done here so a result always goes back,
// even if the agent crashes.
import { spawnSync } from 'node:child_process';
import { runCheck, resultNoteText, sleep } from './lib.mjs';
import { findNewNote, sendNote } from './comms.mjs';

export function workerPrompt(bigeonPath, config, id, taskText) {
  return [
    `You are the worker in a Bigeon foreman loop. Task ${id} has arrived.`,
    '',
    'TASK:',
    taskText.trim(),
    '',
    'Rules:',
    '- Do exactly what the task says, nothing extra.',
    `- When you think you are done, run: node "${bigeonPath}" check`,
    `- If it prints FAIL, read the errors, fix the problem and run it again. At most ${config.maxTries} tries.`,
    '- Do not run "bigeon report" or "bigeon send". The loop reports for you.',
    `- If you changed files inside this git project, commit them on a branch named worker/${id} and push it.`,
    '- Finish with one or two lines saying what you did.',
    '',
  ].join('\n');
}

export function runWorker(projectDir, config, bigeonPath, options = {}) {
  const log = options.log || console.log;
  if (!config.workerCommand) {
    throw new Error('No workerCommand set in bigeon.config.json (for example: cline --auto-approve true "Follow the instructions on stdin")');
  }
  let announcedWaiting = false;
  for (;;) {
    const note = findNewNote(projectDir, config, 'task');
    if (!note) {
      if (options.once) return 2;
      if (!announcedWaiting) log(`[bigeon] waiting for a task (checking every ${config.pollSeconds}s)...`);
      announcedWaiting = true;
      sleep(config.pollSeconds * 1000);
      continue;
    }
    announcedWaiting = false;
    log(`[bigeon] task ${note.id} received:\n${note.text.trim()}\n[bigeon] starting worker agent...`);
    const run = spawnSync(config.workerCommand, {
      cwd: projectDir,
      shell: true,
      input: workerPrompt(bigeonPath, config, note.id, note.text),
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: config.workerTimeoutSeconds * 1000,
      encoding: 'utf8',
    });
    const exitText = run.error && run.error.code === 'ETIMEDOUT' ? 'timed out' : `exit ${run.status}`;
    log(`\n[bigeon] worker agent finished (${exitText}). Running the check...`);
    const result = runCheck(projectDir, config);
    sendNote(projectDir, config, 'result', note.id, resultNoteText(projectDir, result, 'n/a', `worker agent ${exitText}`));
    log(`[bigeon] reported ${result.status} for task ${note.id}`);
    if (options.once) return result.status === 'PASS' ? 0 : 1;
  }
}
