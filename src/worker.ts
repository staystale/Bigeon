// Bigeon worker loop: wait for a task, hand it to the worker agent (visible in this terminal),
// run the check, retry on failure, and send one result note back. Reporting is done here so a
// result always goes back, even if the agent crashes.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Config, WorkerOptions, AgentRun, CheckResult, Note } from './types.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck, formatCheck, resultNoteText, git, mainRef, killPid, killTree } from './lib.ts';
import { findNewNote, markNoteSeen, sendNote, commsDir, RemoteError, writeStatus } from './comms.ts';

const AGENT_TAIL_LINES = 15;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

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
type Marker = { id: string; agentPid: number | null; agentPids: number[]; attempts: number; bootTime: number };

function readMarker(markerPath: string): Marker {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') {
      const agentPid = 'agentPid' in parsed && typeof parsed.agentPid === 'number' ? parsed.agentPid : null;
      const attempts = 'attempts' in parsed && typeof parsed.attempts === 'number' ? parsed.attempts : 0;
      const markerBoot = 'bootTime' in parsed && typeof parsed.bootTime === 'number' ? parsed.bootTime : 0;
      const agentPids =
        'agentPids' in parsed && Array.isArray(parsed.agentPids)
          ? parsed.agentPids.filter((value): value is number => typeof value === 'number')
          : [];
      return { id: parsed.id, agentPid, agentPids, attempts, bootTime: markerBoot };
    }
  } catch {
    // missing or unreadable marker: treat as no interruption
  }
  return { id: '', agentPid: null, agentPids: [], attempts: 0, bootTime: 0 };
}

// When this machine started; differs by a lot after a restart.
function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

function writeMarker(markerPath: string, id: string, agentPid: number | null, attempts: number, agentPids: number[] = []): void {
  fs.writeFileSync(markerPath, JSON.stringify({ id, agentPid, agentPids, attempts, bootTime: bootTime() }));
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

// Every process under rootPid, plus the already known ones and their children (a process whose parent
// exited stays listed). Sorted, never rootPid.
export function descendants(rootPid: number, pairs: Array<[pid: number, parent: number]>, known: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of pairs) {
    const list = children.get(parent);
    if (list) list.push(pid);
    else children.set(parent, [pid]);
  }
  const found = new Set<number>(known.filter((pid) => pid !== rootPid));
  const queue = [rootPid, ...found];
  while (queue.length > 0) {
    for (const pid of children.get(queue.pop() as number) ?? []) {
      if (pid !== rootPid && !found.has(pid)) {
        found.add(pid);
        queue.push(pid);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

// Run the agent, show its output live, and keep the last lines for the result note.
function runAgent(
  projectDir: string,
  config: Config,
  prompt: string,
  onSpawn: (pid: number) => void,
  onTree: (pids: number[]) => void,
): Promise<AgentRun> {
  return new Promise<AgentRun>((resolve) => {
    const child = spawn(config.workerCommand, {
      cwd: projectDir,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    runningAgent = child;
    if (child.pid !== undefined) onSpawn(child.pid);
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
    let exited = false;
    let snapshotTimer: NodeJS.Timeout | undefined;
    let knownPids: number[] = [];
    const rootPid = child.pid;
    if (process.platform === 'win32' && rootPid !== undefined) {
      const snapshot = (): void => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout) => {
            if (exited || error) return;
            const pairs: Array<[number, number]> = [];
            for (const line of stdout.split(/\r?\n/)) {
              const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
              if (match) pairs.push([Number(match[1]), Number(match[2])]);
            }
            const pids = descendants(rootPid, pairs, knownPids);
            if (pids.length === knownPids.length && pids.every((pid, index) => pid === knownPids[index])) return;
            knownPids = pids;
            onTree(pids);
          },
        );
      };
      snapshotTimer = setTimeout(function tick() {
        if (exited) return;
        snapshot();
        snapshotTimer = setTimeout(tick, 3000);
      }, 1000);
    }
    child.on('close', (code) => {
      exited = true;
      runningAgent = null;
      if (snapshotTimer) clearTimeout(snapshotTimer);
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

function extraLinesFor(projectDir: string, config: Config, stashed: boolean): string[] | undefined {
  const lines: string[] = [];
  const base = baseLine(projectDir, config);
  if (base) lines.push(base);
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

// Status text for the foreman. Version is the short commit of the Bigeon folder itself.
function bigeonVersion(bigeonPath: string): string {
  const result = git(['-C', path.dirname(bigeonPath), 'rev-parse', '--short', 'HEAD'], process.cwd());
  return result.ok && result.out.trim() ? result.out.trim() : 'unknown';
}

type StatusReporter = {
  publish: (state: string) => void;
  heartbeat: () => void;
  startBeat: () => NodeJS.Timeout | undefined;
};

// Writes the worker status when the state changes and again every heartbeatMinutes. Writes nothing when heartbeatMinutes is 0.
function makeStatusReporter(projectDir: string, config: Config, bigeonPath: string): StatusReporter {
  const version = bigeonVersion(bigeonPath);
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
      `Version: ${version}`,
    ].join('\n'));
  };
  return {
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
        const stopped: number[] = [];
        for (const pid of [leftoverPid, ...marker.agentPids]) {
          if (!isRunning(pid)) continue;
          try {
            killPid(pid);
          } catch {
            // already gone
          }
          stopped.push(pid);
        }
        if (stopped.length > 0) log(`[bigeon] stopped leftover agent ${stopped.join(', ')} from an interrupted run`);
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
      let agentPid: number | null = null;
      status.publish(`working on ${taskId} (try ${tries} of ${config.maxTries})`);
      const beat = status.startBeat();
      let run: AgentRun;
      try {
        run = await runAgent(projectDir, config, workerPrompt(bigeonPath, config, note.id, note.text, previousFailure), (pid) => {
          agentPid = pid;
          writeMarker(markerPath, taskId, pid, attempts);
        }, (pids) => {
          writeMarker(markerPath, taskId, agentPid, attempts, pids);
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
  const status = makeStatusReporter(projectDir, config, bigeonPath);
  const onSignal = (): void => {
    if (runningAgent) killTree(runningAgent);
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
