// Bigeon worker loop: wait for a task, hand it to the worker agent (visible in this terminal),
// run the check, retry on failure, and send one result note back. Reporting is done here so a
// result always goes back, even if the agent crashes.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { Config, WorkerOptions, AgentRun, CheckResult, Note } from './types.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck, formatCheck, resultNoteText, git, mainRef, killPid, killTree, processStartTimes, stopRunningCheck, ANSI_PATTERN, bigeonUpdate, versionLine, updateStatusLine } from './lib.ts';
import type { BigeonUpdate } from './lib.ts';
import { findNewNote, markNoteSeen, sendNote, commsDir, RemoteError, writeStatus } from './comms.ts';

const AGENT_TAIL_LINES = 15;
const UPDATE_CHECK_MS = 60 * 60000;

// Turn the worker status text into one line plus an exit code for `bigeon status`.
export function describeStatus(
  text: string,
  nowMs: number,
  heartbeatMinutes: number,
): { line: string; exitCode: number } {
  const state = /^State: (.+)$/m.exec(text)?.[1]?.trim();
  const lastSeen = /^Last seen: (.+)$/m.exec(text)?.[1]?.trim();
  const seenMs = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!state || Number.isNaN(seenMs)) return { line: 'worker status unreadable', exitCode: 4 };
  const ageMin = Math.max(0, Math.floor((nowMs - seenMs) / 60000));
  if (state === 'stopped') return { line: `worker stopped (last seen ${ageMin} min ago)`, exitCode: 4 };
  if (ageMin > 3 * heartbeatMinutes) {
    return { line: `worker seems down: ${state}, last seen ${ageMin} min ago`, exitCode: 4 };
  }
  return { line: `worker: ${state}, last seen ${ageMin} min ago`, exitCode: 0 };
}

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
    '- Your shell stops commands after about 30 seconds. While working, run only quick checks (the type check,',
    '  or one test file such as: node --test test/<file>.test.ts). Do not run the full check yourself: when you',
    `  finish, the loop runs it (node "${bigeonPath}" check) and sends you any failure to fix.`,
    '- Do not edit the check or bigeon.config.json to make it pass.',
    '- Do not run "bigeon report" or "bigeon send". The loop reports for you.',
    `- If you changed files inside this git project, commit them on a branch named worker/${id} and push it.`,
    `- If the branch worker/${id} already exists from an earlier interrupted run, start it again from origin/main.`,
    `- Processes: the bigeon worker loop running you has pid ${process.pid}. Never stop it, its parent, or any process`,
    '  you did not start yourself, unless the foreman or the user tells you to. Never stop processes by name or by',
    '  matching command lines (no Stop-Process/taskkill/pkill on "node" or "bigeon").',
    '- Run tests and checks in the foreground, one at a time, and wait for them to finish. Never start them in the',
    '  background (no Start-Process, Start-Job or "&") and never run two at once.',
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
type Marker = { id: string; agentPid: number | null; attempts: number; bootTime: number; agentStarts: Record<string, string> };

function readMarker(markerPath: string): Marker {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') {
      const agentPid = 'agentPid' in parsed && typeof parsed.agentPid === 'number' ? parsed.agentPid : null;
      const attempts = 'attempts' in parsed && typeof parsed.attempts === 'number' ? parsed.attempts : 0;
      const markerBoot = 'bootTime' in parsed && typeof parsed.bootTime === 'number' ? parsed.bootTime : 0;
      const agentStarts: Record<string, string> = {};
      if ('agentStarts' in parsed && typeof parsed.agentStarts === 'object' && parsed.agentStarts !== null) {
        for (const [key, value] of Object.entries(parsed.agentStarts)) {
          if (typeof value === 'string') agentStarts[key] = value;
        }
      }
      return { id: parsed.id, agentPid, attempts, bootTime: markerBoot, agentStarts };
    }
  } catch {
    // missing or unreadable marker: treat as no interruption
  }
  return { id: '', agentPid: null, attempts: 0, bootTime: 0, agentStarts: {} };
}

// When this machine started; differs by a lot after a restart.
function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

function writeMarker(markerPath: string, id: string, agentPid: number | null, attempts: number, agentStarts: Record<string, string> = {}): void {
  fs.writeFileSync(markerPath, JSON.stringify({ id, agentPid, attempts, bootTime: bootTime(), agentStarts }));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let runningAgent: ChildProcess | null = null;

// Stop the agent: on Windows kill its tree; elsewhere ask the guard, which kills the agent's process group.
function stopAgent(child: ChildProcess): void {
  if (process.platform === 'win32') killTree(child);
  else child.kill('SIGTERM');
}

// Run the agent, show its output live, and keep the last lines for the result note.
function runAgent(
  projectDir: string,
  config: Config,
  prompt: string,
  onSpawn: (pid: number) => void,
): Promise<AgentRun> {
  return new Promise<AgentRun>((resolve) => {
    // On Windows the guard puts the agent in a Job Object: Windows kills it and all it started when the worker stops.
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('./guard-win.ps1', import.meta.url)),
        String(process.pid),
        Buffer.from(config.workerCommand, 'utf8').toString('base64'),
      ], { cwd: projectDir, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
      // Elsewhere the guard keeps the agent in its own process group and kills it when the worker is gone.
      : spawn(process.execPath, [
        fileURLToPath(new URL('./guard-posix.ts', import.meta.url)),
        String(process.pid),
        Buffer.from(config.workerCommand, 'utf8').toString('base64'),
      ], { cwd: projectDir, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    runningAgent = child;
    if (child.pid !== undefined) onSpawn(child.pid);
    let captured = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopAgent(child);
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
      runningAgent = null;
      clearTimeout(timer);
      resolve({ exitText: timedOut ? 'timed out' : `exit ${code}`, output: captured });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0';

export const CP850_HIGH = [
  'ÇüéâäàåçêëèïîìÄÅ',
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ',
  'áíóúñÑªº¿®¬½¼¡«»',
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐',
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤',
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀',
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´',
  '\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0',
].join('');

// Decode a line whose UTF-8 bytes were shown through a code page; returns the line if it does not fit.
function decodeWith(line: string, table: string): string {
  const bytes: number[] = [];
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const index = table.indexOf(char);
    if (index < 0) {
      return line;
    }
    bytes.push(0x80 + index);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return line;
  }
}

export function repairMojibake(line: string): string {
  for (const table of [CP437_HIGH, CP850_HIGH]) {
    const repaired = decodeWith(line, table);
    if (repaired !== line) {
      return repaired;
    }
  }
  return line;
}

export function agentTail(output: string): string[] {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines
    .slice(-AGENT_TAIL_LINES)
    .map(repairMojibake)
    .map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line));
}

// One line saying which main commit the work is based on, and whether it is behind; null if unknown.
export function baseLine(projectDir: string, config: Config): string | null {
  git(['fetch', '--quiet', config.remote], projectDir);
  const main = mainRef(projectDir, config.remote);
  if (!main) return null;
  const mergeBase = git(['merge-base', 'HEAD', main], projectDir);
  if (!mergeBase.ok || !mergeBase.out) return null;
  const base = git(['rev-parse', '--short', mergeBase.out], projectDir);
  const behindCount = git(['rev-list', '--count', `HEAD..${main}`], projectDir);
  if (!base.ok || !behindCount.ok || !base.out || !behindCount.out) return null;
  if (behindCount.out === '0') return `Base: ${base.out} (up to date with ${main})`;
  return `Base: ${base.out}, WARNING ${behindCount.out} commit(s) behind ${main}`;
}

// One line listing uncommitted files in the folder (report only, never touched); null if none or git fails.
export function dirtyLine(projectDir: string): string | null {
  const status = git(['status', '--porcelain'], projectDir);
  if (!status.ok || !status.out) return null;
  // git() trims its output, which can eat the first line's leading space, so the status is 1-2 characters here.
  const paths = status.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2} /, ''));
  const n = paths.length;
  return `Dirty: ${n} uncommitted file(s) (${paths.slice(0, 5).join(', ')}${n > 5 ? ', ...' : ''})`;
}

function extraLinesFor(projectDir: string, config: Config, stashed: boolean): string[] | undefined {
  const lines: string[] = [];
  const base = baseLine(projectDir, config);
  if (base) lines.push(base);
  const dirty = dirtyLine(projectDir);
  if (dirty) lines.push(dirty);
  if (stashed) lines.push(STASH_NOTE);
  return lines.length > 0 ? lines : undefined;
}

const STASH_NOTE = 'Stashed: leftovers from the interrupted run (git stash list)';

// Send the result (retrying while the remote is unreachable), then mark the task seen and drop the marker.
async function sendResult(
  projectDir: string,
  config: Config,
  note: Note,
  markerPath: string,
  text: string,
  log: (message: string) => void,
): Promise<void> {
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
      await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
    }
  }
  markNoteSeen(projectDir, 'task', note);
  fs.rmSync(markerPath, { force: true });
}

type StatusReporter = {
  setUpdate: (update: BigeonUpdate) => void;
  publish: (state: string) => void;
  heartbeat: () => void;
  startBeat: () => NodeJS.Timeout | undefined;
};

// Writes the worker status when the state changes and again every heartbeatMinutes. Writes nothing when heartbeatMinutes is 0.
function makeStatusReporter(projectDir: string, config: Config): StatusReporter {
  let update: BigeonUpdate = { version: 'unknown', behind: null };
  const intervalMs = config.heartbeatMinutes * 60000;
  let state = '';
  let since = '';
  let lastWrite = 0;
  const write = (): void => {
    const now = new Date();
    lastWrite = now.getTime();
    writeStatus(projectDir, config, [
      `State: ${state}`,
      `Since: ${since}`,
      `Last seen: ${now.toISOString()}`,
      `Version: ${update.version}`,
      updateStatusLine(update),
    ].join('\n'));
  };
  return {
    setUpdate: (next: BigeonUpdate): void => {
      update = next;
    },
    publish: (next: string): void => {
      if (intervalMs <= 0) return;
      state = next;
      since = new Date().toISOString();
      write();
    },
    heartbeat: (): void => {
      if (intervalMs <= 0 || !state) return;
      if (Date.now() - lastWrite >= intervalMs) write();
    },
    startBeat: (): NodeJS.Timeout | undefined => {
      if (intervalMs <= 0) return undefined;
      return setInterval(() => {
        write();
      }, intervalMs);
    },
  };
}

async function runLoop(
  projectDir: string,
  config: Config,
  bigeonPath: string,
  status: StatusReporter,
  options: WorkerOptions = {},
): Promise<number> {
  const log = options.log || console.log;
  if (!config.workerCommand) {
    throw new Error('No workerCommand set in bigeon.config.json (for example: cline --auto-approve true "Follow the instructions on stdin")');
  }
  let announcedWaiting = false;
  let lastMessage = '';
  const bigeonDir = path.dirname(path.dirname(bigeonPath));
  let lastUpdate = bigeonUpdate(bigeonDir);
  let lastUpdateLine = versionLine(lastUpdate, bigeonDir);
  let lastUpdateCheck = Date.now();
  status.setUpdate(lastUpdate);
  log(lastUpdateLine);
  status.publish('idle');
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
      await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
      continue;
    }
    if (!note) {
      if (options.once) return 2;
      if (Date.now() - lastUpdateCheck >= UPDATE_CHECK_MS) {
        lastUpdateCheck = Date.now();
        lastUpdate = bigeonUpdate(bigeonDir);
        status.setUpdate(lastUpdate);
        const line = versionLine(lastUpdate, bigeonDir);
        if (line !== lastUpdateLine) {
          lastUpdateLine = line;
          log(line);
        }
      }
      status.heartbeat();
      if (!announcedWaiting) log(`[bigeon] waiting for a task (checking every ${config.pollSeconds}s)...`);
      announcedWaiting = true;
      await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
      continue;
    }
    announcedWaiting = false;
    const markerPath = path.join(projectDir, '.bigeon', 'in-progress.json');
    log(`[bigeon] task ${note.id} received:\n${note.text.trim()}`);

    // A result already pushed means an earlier run crashed before marking the task seen.
    const resultPath = path.join(commsDir(projectDir), 'results', `${note.id}.md`);
    const existing = fs.existsSync(resultPath) ? /^Status: (PASS|FAIL)$/m.exec(fs.readFileSync(resultPath, 'utf8')) : null;
    if (existing) {
      markNoteSeen(projectDir, 'task', note);
      fs.rmSync(markerPath, { force: true });
      log(`[bigeon] task ${note.id} already has a ${existing[1]} result, skipping`);
      if (options.once) return 0;
      continue;
    }
    if (fs.existsSync(resultPath)) log(`[bigeon] task ${note.id} has an incomplete result, doing it again`);
    // Only after a real interruption (marker for this same task): stash leftovers, never delete them.
    const marker = readMarker(markerPath);
    const attempts = (marker.id === note.id ? marker.attempts : 0) + 1;
    let stashed = false;
    if (marker.id === note.id && git(['status', '--porcelain'], projectDir).out) {
      log(`[bigeon] stashing leftovers from interrupted task ${note.id} (git stash list to recover)`);
      git(['stash', 'push', '--include-untracked', '--quiet', '-m', `bigeon: leftovers from interrupted task ${note.id}`], projectDir);
      stashed = true;
    }
    const leftoverPid = marker.agentPid;
    if (leftoverPid !== null) {
      if (Math.abs(marker.bootTime - bootTime()) >= 60000) {
        log(`[bigeon] machine restarted since the interrupted run, not stopping old pid ${leftoverPid}`);
      } else {
        if (isRunning(leftoverPid)) {
          const recorded = marker.agentStarts[String(leftoverPid)];
          if (recorded !== undefined && processStartTimes([leftoverPid]).get(leftoverPid) !== recorded) {
            log(`[bigeon] not stopping pid ${leftoverPid}: it is a different process now`);
          } else {
            try {
              if (process.platform === 'win32') killPid(leftoverPid);
              else process.kill(leftoverPid, 'SIGTERM');
            } catch {
              // already gone
            }
            log(`[bigeon] stopped leftover agent ${leftoverPid} from an interrupted run`);
          }
        }
      }
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    writeMarker(markerPath, note.id, null, attempts);

    if (attempts > config.maxTries) {
      const giveUp: CheckResult = {
        status: 'FAIL',
        exitCode: null,
        timedOut: false,
        errors: [`interrupted ${attempts - 1} times, giving up`],
        hiddenLineCount: 0,
      };
      const giveUpText = resultNoteText(projectDir, giveUp, 0, 'gave up', undefined, extraLinesFor(projectDir, config, stashed));
      await sendResult(projectDir, config, note, markerPath, giveUpText, log);
      log(`[bigeon] task ${note.id} interrupted ${attempts - 1} times, giving up`);
      if (options.once) return 1;
      continue;
    }

    // Assigned in the loop below (original code assumed maxTries >= 1).
    let result!: CheckResult;
    let previousFailure = '';
    let agentSaid: string[] = [];
    let exitText = '';
    let tries = 0;
    while (tries < config.maxTries) {
      tries += 1;
      log(`[bigeon] starting worker agent (try ${tries} of ${config.maxTries})...`);
      const taskId = note.id;
      status.publish(`working on ${taskId} (try ${tries} of ${config.maxTries})`);
      const beat = status.startBeat();
      let run: AgentRun;
      try {
        run = await runAgent(projectDir, config, workerPrompt(bigeonPath, config, note.id, note.text, previousFailure), (pid) => {
          const start = processStartTimes([pid]).get(pid);
          writeMarker(markerPath, taskId, pid, attempts, start === undefined ? {} : { [String(pid)]: start });
        });
      } finally {
        clearInterval(beat);
      }
      exitText = run.exitText;
      agentSaid = agentTail(run.output);
      log(`\n[bigeon] worker agent finished (${exitText}). Running the check...`);
      result = await runCheck(projectDir, config);
      if (result.status === 'PASS') break;
      previousFailure = formatCheck(result);
      log(`[bigeon] check failed:\n${previousFailure}`);
    }

    const summary = `worker agent ${exitText}`;
    const text = resultNoteText(projectDir, result, tries, summary, agentSaid, extraLinesFor(projectDir, config, stashed));
    await sendResult(projectDir, config, note, markerPath, text, log);
    log(`[bigeon] reported ${result.status} for task ${note.id} after ${tries} ${tries === 1 ? 'try' : 'tries'}`);
    status.publish('idle');
    if (options.once) return result.status === 'PASS' ? 0 : 1;
  }
}

export async function runWorker(
  projectDir: string,
  config: Config,
  bigeonPath: string,
  options: WorkerOptions = {},
): Promise<number> {
  const log = options.log || console.log;
  const lockPath = path.join(projectDir, '.bigeon', 'worker.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    let otherPid = 0;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'pid' in parsed && typeof parsed.pid === 'number') otherPid = parsed.pid;
    } catch {
      // unreadable lock: treat as stale
    }
    if (otherPid > 0 && isRunning(otherPid)) {
      throw new Error(`another bigeon worker is already running in this folder (pid ${otherPid})`);
    }
    log('[bigeon] took over a stale lock');
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  const removeLock = (): void => {
    fs.rmSync(lockPath, { force: true });
  };
  const status = makeStatusReporter(projectDir, config);
  const onSignal = (): void => {
    if (runningAgent) stopAgent(runningAgent);
    stopRunningCheck();
    status.publish('stopped');
    removeLock();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await runLoop(projectDir, config, bigeonPath, status, options);
  } finally {
    status.publish('stopped');
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    removeLock();
  }
}
