// Bigeon worker loop: wait for a task, hand it to the worker agent (visible in this terminal),
// run the check, retry on failure, and send one result note back. Reporting is done here so a
// result always goes back, even if the agent crashes.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Config, WorkerOptions, AgentRun, CheckResult, Note } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { runCheck, formatCheck, resultNoteText, sleep, git } from './lib.ts';
import { findNewNote, markNoteSeen, sendNote, commsDir, RemoteError } from './comms.ts';

const AGENT_TAIL_LINES = 15;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function workerPrompt(
  bigeonPath: string,
  config: Config,
  id: string,
  taskText: string,
  previousFailure: string,
): string {
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
    `- If the branch worker/${id} already exists from an earlier interrupted run, start it again from origin/main.`,
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

// The id of the task a previous run left unfinished, or '' when there is no (readable) marker.
function readMarkerId(markerPath: string): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') return parsed.id;
  } catch {
    // missing or unreadable marker: treat as no interruption
  }
  return '';
}

// Stop the child and everything it started (the shell wrapper alone is not enough).
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Run the agent, show its output live, and keep the last lines for the result note.
function runAgent(projectDir: string, config: Config, prompt: string): Promise<AgentRun> {
  return new Promise<AgentRun>((resolve) => {
    const child = spawn(config.workerCommand, {
      cwd: projectDir,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let captured = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, config.workerTimeoutSeconds * 1000);
    const forward = (stream: NodeJS.ReadableStream, target: NodeJS.WritableStream) => stream.on('data', (chunk: Buffer | string) => {
      target.write(chunk);
      captured += chunk.toString();
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', (error: Error) => {
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

export function agentTail(output: string): string[] {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.slice(-AGENT_TAIL_LINES).map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line));
}

export async function runWorker(
  projectDir: string,
  config: Config,
  bigeonPath: string,
  options: WorkerOptions = {},
): Promise<number> {
  const log = options.log || console.log;
  if (!config.workerCommand) {
    throw new Error('No workerCommand set in bigeon.config.json (for example: cline --auto-approve true "Follow the instructions on stdin")');
  }
  let announcedWaiting = false;
  let lastMessage = '';
  for (;;) {
    let note: Note | null = null;
    try {
      note = findNewNote(projectDir, config, 'task', { markSeen: false });
      if (lastMessage) log('[bigeon] reconnected');
      lastMessage = '';
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      if (options.once) {
        console.error(error.message);
        return 3;
      }
      if (error.message !== lastMessage) {
        log(`[bigeon] ${error.message} (retrying every ${config.pollSeconds}s)`);
        lastMessage = error.message;
      }
      sleep(config.pollSeconds * 1000);
      continue;
    }
    if (!note) {
      if (options.once) return 2;
      if (!announcedWaiting) log(`[bigeon] waiting for a task (checking every ${config.pollSeconds}s)...`);
      announcedWaiting = true;
      sleep(config.pollSeconds * 1000);
      continue;
    }
    announcedWaiting = false;
    const markerPath = path.join(projectDir, '.bigeon', 'in-progress.json');
    log(`[bigeon] task ${note.id} received:\n${note.text.trim()}`);

    // A result already pushed means an earlier run crashed before marking the task seen.
    if (fs.existsSync(path.join(commsDir(projectDir), 'results', `${note.id}.md`))) {
      markNoteSeen(projectDir, 'task', note);
      fs.rmSync(markerPath, { force: true });
      log(`[bigeon] task ${note.id} already has a result, skipping`);
      if (options.once) return 0;
      continue;
    }
    // Only after a real interruption (marker for this same task): stash leftovers, never delete them.
    if (readMarkerId(markerPath) === note.id && git(['status', '--porcelain'], projectDir).out) {
      log(`[bigeon] stashing leftovers from interrupted task ${note.id} (git stash list to recover)`);
      git(['stash', 'push', '--include-untracked', '--quiet', '-m', `bigeon: leftovers from interrupted task ${note.id}`], projectDir);
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ id: note.id }));

    // Assigned in the loop below (original code assumed maxTries >= 1).
    let result!: CheckResult;
    let previousFailure = '';
    let agentSaid: string[] = [];
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
    const text = resultNoteText(projectDir, result, tries, summary, agentSaid);
    let lastSendError = '';
    for (;;) {
      try {
        sendNote(projectDir, config, 'result', note.id, text);
        break;
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        if (error.message !== lastSendError) {
          log(`[bigeon] ${error.message} (retrying every ${config.pollSeconds}s)`);
          lastSendError = error.message;
        }
        sleep(config.pollSeconds * 1000);
      }
    }
    markNoteSeen(projectDir, 'task', note);
    fs.rmSync(markerPath, { force: true });
    log(`[bigeon] reported ${result.status} for task ${note.id} after ${tries} ${tries === 1 ? 'try' : 'tries'}`);
    if (options.once) return result.status === 'PASS' ? 0 : 1;
  }
}
