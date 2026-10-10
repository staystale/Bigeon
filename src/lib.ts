// Bigeon core: config, git helper, and the check runner. No runtime dependencies, Node 22.18+.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config, CheckResult, GitResult } from './types.ts';

export const DEFAULT_CONFIG: Config = {
  checkCommand: '',
  errorLines: 20,
  maxTries: 3,
  pollSeconds: 30,
  commsBranch: 'agent-comms',
  remote: 'origin',
  checkTimeoutSeconds: 300,
  workerCommand: '',
  workerTimeoutSeconds: 900,
  heartbeatMinutes: 10,
};

export const CONFIG_FILE = 'bigeon.config.json';
export const STATE_DIR = '.bigeon';

export function loadConfig(projectDir: string): Config {
  const configPath = path.join(projectDir, CONFIG_FILE);
  let userConfig: Partial<Config> = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  for (const [field, wording, isValid] of CONFIG_RULES) {
    const value: unknown = config[field];
    if (!isValid(value)) throw new Error(`${CONFIG_FILE}: "${field}" must be ${wording}, got "${String(value)}"`);
  }
  return config;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const CONFIG_RULES: [keyof Config, string, (value: unknown) => boolean][] = [
  ['errorLines', 'a whole number of at least 1', (v) => isNumber(v) && Number.isInteger(v) && v >= 1],
  ['maxTries', 'a whole number of at least 1', (v) => isNumber(v) && Number.isInteger(v) && v >= 1],
  ['pollSeconds', 'a number above 0', (v) => isNumber(v) && v > 0],
  ['checkTimeoutSeconds', 'a number above 0', (v) => isNumber(v) && v > 0],
  ['workerTimeoutSeconds', 'a number above 0', (v) => isNumber(v) && v > 0],
  ['heartbeatMinutes', 'a number of 0 or more', (v) => isNumber(v) && v >= 0],
  ['checkCommand', 'text', (v) => typeof v === 'string'],
  ['workerCommand', 'text', (v) => typeof v === 'string'],
  ['remote', 'text', (v) => typeof v === 'string'],
  ['commsBranch', 'text', (v) => typeof v === 'string'],
];

export function git(args: string[], workingDir?: string): GitResult {
  const result = spawnSync('git', args, { cwd: workingDir, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: (result.stdout || '').trim(),
    err: (result.stderr || '').trim() || (result.error ? result.error.message : ''),
  };
}

// The remote's main branch as a ref name (e.g. origin/main); null if it cannot be found.
export function mainRef(projectDir: string, remote: string): string | null {
  const head = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], projectDir);
  if (head.ok && head.out) return head.out;
  if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/main`], projectDir).ok) {
    return `${remote}/main`;
  }
  return null;
}

// Stop early with a plain message if git cannot be run (common after installing git: the terminal
// that was already open does not know about it until it is closed and reopened).
export function requireGit(): void {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      'git was not found. Bigeon passes notes through git, so it cannot run without it.\n'
      + 'If git is installed, close this terminal and open a new one so it picks up the updated PATH.',
    );
  }
}

export function mustGit(args: string[], workingDir?: string): string {
  const result = git(args, workingDir);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.err || result.out}`);
  }
  return result.out;
}

export const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const STRONG_MARKER = /✖|^\s*not ok\b|\bFAIL\b|Error:|AssertionError|Traceback|panic:/;
const WEAK_MARKER = /error|fail/i;
const ZERO_SUMMARY = /\b(fail|failed|failures|errors?)\s*[:=]?\s*0\b/i;

// Pick the lines that show the failure: a window starting 2 lines before the
// first strong (else weak) marker, or the last `count` lines if none match.
export function pickErrorLines(allLines: string[], count: number): { shown: string[]; hidden: number } {
  let found = allLines.findIndex((line) => STRONG_MARKER.test(line));
  if (found < 0) {
    found = allLines.findIndex((line) => WEAK_MARKER.test(line) && !ZERO_SUMMARY.test(line));
  }
  const shown =
    found >= 0
      ? allLines.slice(Math.max(0, found - 2), Math.max(0, found - 2) + count)
      : allLines.slice(Math.max(0, allLines.length - count));
  return { shown, hidden: allLines.length - shown.length };
}

// Stop a process and everything it started (the shell wrapper alone is not enough).
export function killPid(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    killPid(child.pid);
  } catch {
    child.kill('SIGKILL');
  }
}

const CHECK_OUTPUT_CAP = 64 * 1024 * 1024;

// Run the project's check command. Returns a short, token-cheap summary.
export async function runCheck(projectDir: string, config: Config): Promise<CheckResult> {
  if (!config.checkCommand) {
    throw new Error(`No checkCommand set in ${CONFIG_FILE}`);
  }
  const command = config.checkCommand;
  const run = await new Promise<{ code: number | null; text: string; timedOut: boolean }>((resolve) => {
    const child = spawn(command, {
      cwd: projectDir,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const collect = (stream: NodeJS.ReadableStream, which: 'out' | 'err'): void => {
      stream.on('data', (chunk: Buffer | string) => {
        const piece = chunk.toString();
        if (which === 'out') {
          if (out.length < CHECK_OUTPUT_CAP) out += piece.slice(0, CHECK_OUTPUT_CAP - out.length);
        } else if (err.length < CHECK_OUTPUT_CAP) {
          err += piece.slice(0, CHECK_OUTPUT_CAP - err.length);
        }
      });
    };
    collect(child.stdout, 'out');
    collect(child.stderr, 'err');
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, config.checkTimeoutSeconds * 1000);
    child.on('error', (error: Error) => {
      err += `\n${error.message}\n`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text: `${out}\n${err}`, timedOut });
    });
  });
  const timedOut = run.timedOut;
  const exitCode = timedOut ? null : run.code;
  const combined = run.text.replace(ANSI_PATTERN, '');
  const allLines = combined.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);

  if (!timedOut && exitCode === 0) {
    return { status: 'PASS', exitCode, timedOut: false, errors: [], hiddenLineCount: 0 };
  }
  const picked = pickErrorLines(allLines, config.errorLines);
  return {
    status: 'FAIL',
    exitCode,
    timedOut,
    errors: picked.shown,
    hiddenLineCount: picked.hidden,
  };
}
export function formatCheck(checkResult: CheckResult): string {
  if (checkResult.status === 'PASS') return 'PASS';
  const reason = checkResult.timedOut ? 'timed out' : `exit code ${checkResult.exitCode}`;
  const lines = [`FAIL (${reason})`, ...checkResult.errors];
  if (checkResult.hiddenLineCount > 0) lines.push(`... ${checkResult.hiddenLineCount} more lines hidden`);
  return lines.join('\n');
}

export function resultNoteText(
  projectDir: string,
  checkResult: CheckResult,
  tries: number,
  summary?: string,
  agentSaid?: string[],
  extraLines?: string[],
): string {
  const lines = [`Status: ${checkResult.status}`, `Commit: ${currentCommit(projectDir)}`, `Tries: ${tries}`];
  if (checkResult.status === 'FAIL') lines.push('Errors:', formatCheck(checkResult));
  if (summary) lines.push(`Summary: ${summary}`);
  if (extraLines) lines.push(...extraLines);
  if (agentSaid && agentSaid.length > 0) lines.push('Worker said:', ...agentSaid);
  return lines.join('\n');
}

export function currentCommit(projectDir: string): string {
  const result = git(['rev-parse', '--short', 'HEAD'], projectDir);
  return result.ok ? result.out : 'unknown';
}

export function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function initProject(projectDir: string): string[] {
  const created: string[] = [];
  const configPath = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    created.push(CONFIG_FILE);
  }
  const ignorePath = path.join(projectDir, '.gitignore');
  const ignoreText = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const ignoreLines = ignoreText.split(/\r?\n/);
  let separator = ignoreText && !ignoreText.endsWith('\n') ? '\n' : '';
  for (const entry of [`${STATE_DIR}/`, CONFIG_FILE]) {
    if (ignoreLines.includes(entry)) continue;
    fs.appendFileSync(ignorePath, `${separator}${entry}\n`);
    separator = '';
    created.push(`.gitignore (+${entry})`);
  }
  return created;
}
