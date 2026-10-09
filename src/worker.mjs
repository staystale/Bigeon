// Bigeon worker loop: wait for a task, hand it to the worker agent (visible in this terminal),
// run the check, retry on failure, and send one result note back. Reporting is done here so a
// result always goes back, even if the agent crashes.
import { spawn } from 'node:child_process';
import { runCheck, formatCheck, resultNoteText, sleep } from './lib.ts';
import { findNewNote, sendNote } from './comms.mjs';

const AGENT_TAIL_LINES = 15;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function workerPrompt(bigeonPath, config, id, taskText, previousFailure) {
  const lines = [
    `You are the worker in a Bigeon foreman loop. Task ${id} has arrived.`,
    '',
    'TASK:',
    taskText.trim(),
    '',
    'Rules:',
    '- Do exactly what the task says, nothing extra.',
    `- When you think you are done, run: node "${bigeonPath}" check`,
    '- Do not edit the check or bigeon.config.json to make it pass.',
    '- Do not run "bigeon report" or "bigeon send". The loop reports for you.',
    `- If you changed files inside this git project, commit them on a branch named worker/${id} and push it.`,
    '- Finish with one or two lines saying what you did and anything you could not do.',
    '',
  ];
  if (previousFailure) {
    lines.push(
      'This is a retry. Your last attempt failed the check with this output:',
      previousFailure,
      'Fix the cause, then run the check again.',
      '',
    );
  }
  return lines.join('\n');
}

// Run the agent, show its output live, and keep the last lines for the result note.
function runAgent(projectDir, config, prompt) {
  return new Promise((resolve) => {
    const child = spawn(config.workerCommand, { cwd: projectDir, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let captured = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, config.workerTimeoutSeconds * 1000);
    const forward = (stream, target) => stream.on('data', (chunk) => {
      target.write(chunk);
      captured += chunk.toString();
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', (error) => {
      captured += `\n${error.message}\n`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitText: timedOut ? 'timed out' : `exit ${code}`, output: captured });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export function agentTail(output) {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.slice(-AGENT_TAIL_LINES).map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line));
}

export async function runWorker(projectDir, config, bigeonPath, options = {}) {
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
    log(`[bigeon] task ${note.id} received:\n${note.text.trim()}`);

    let result = null;
    let previousFailure = '';
    let agentSaid = [];
    let exitText = '';
    let tries = 0;
    while (tries < config.maxTries) {
      tries += 1;
      log(`[bigeon] starting worker agent (try ${tries} of ${config.maxTries})...`);
      const run = await runAgent(projectDir, config, workerPrompt(bigeonPath, config, note.id, note.text, previousFailure));
      exitText = run.exitText;
      agentSaid = agentTail(run.output);
      log(`\n[bigeon] worker agent finished (${exitText}). Running the check...`);
      result = runCheck(projectDir, config);
      if (result.status === 'PASS') break;
      previousFailure = formatCheck(result);
      log(`[bigeon] check failed:\n${previousFailure}`);
    }

    const summary = `worker agent ${exitText}`;
    const text = resultNoteText(projectDir, result, String(tries), summary, agentSaid);
    sendNote(projectDir, config, 'result', note.id, text);
    log(`[bigeon] reported ${result.status} for task ${note.id} after ${tries} ${tries === 1 ? 'try' : 'tries'}`);
    if (options.once) return result.status === 'PASS' ? 0 : 1;
  }
}
