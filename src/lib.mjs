// Bigeon core: config, git helper, and the check runner. No dependencies, Node 18+.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  checkCommand: '',
  errorLines: 20,
  maxTries: 3,
  pollSeconds: 30,
  commsBranch: 'agent-comms',
  remote: 'origin',
  checkTimeoutSeconds: 300,
  workerCommand: '',
  workerTimeoutSeconds: 900,
};

export const CONFIG_FILE = 'bigeon.config.json';
export const STATE_DIR = '.bigeon';

export function loadConfig(projectDir) {
  const configPath = path.join(projectDir, CONFIG_FILE);
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...userConfig };
}

export function git(args, workingDir) {
  const result = spawnSync('git', args, { cwd: workingDir, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: (result.stdout || '').trim(),
    err: (result.stderr || '').trim() || (result.error ? result.error.message : ''),
  };
}

// Stop early with a plain message if git cannot be run (common after installing git: the terminal
// that was already open does not know about it until it is closed and reopened).
export function requireGit() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      'git was not found. Bigeon passes notes through git, so it cannot run without it.\n'
      + 'If git is installed, close this terminal and open a new one so it picks up the updated PATH.',
    );
  }
}

export function mustGit(args, workingDir) {
  const result = git(args, workingDir);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.err || result.out}`);
  }
  return result.out;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

// Run the project's check command. Returns a short, token-cheap summary.
export function runCheck(projectDir, config) {
  if (!config.checkCommand) {
    throw new Error(`No checkCommand set in ${CONFIG_FILE}`);
  }
  const run = spawnSync(config.checkCommand, {
    cwd: projectDir,
    shell: true,
    encoding: 'utf8',
    timeout: config.checkTimeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');
  const exitCode = timedOut ? null : run.status;
  const combined = `${run.stdout || ''}\n${run.stderr || ''}`.replace(ANSI_PATTERN, '');
  const allLines = combined.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);

  if (!timedOut && exitCode === 0) {
    return { status: 'PASS', exitCode, timedOut: false, errors: [], hiddenLineCount: 0 };
  }
  const shown = allLines.slice(0, config.errorLines);
  return {
    status: 'FAIL',
    exitCode,
    timedOut,
    errors: shown,
    hiddenLineCount: Math.max(0, allLines.length - shown.length),
  };
}

export function formatCheck(checkResult) {
  if (checkResult.status === 'PASS') return 'PASS';
  const reason = checkResult.timedOut ? 'timed out' : `exit code ${checkResult.exitCode}`;
  const lines = [`FAIL (${reason})`, ...checkResult.errors];
  if (checkResult.hiddenLineCount > 0) lines.push(`... ${checkResult.hiddenLineCount} more lines hidden`);
  return lines.join('\n');
}

export function resultNoteText(projectDir, checkResult, tries, summary) {
  const lines = [`Status: ${checkResult.status}`, `Commit: ${currentCommit(projectDir)}`, `Tries: ${tries}`];
  if (checkResult.status === 'FAIL') lines.push('Errors:', formatCheck(checkResult));
  if (summary) lines.push(`Summary: ${summary}`);
  return lines.join('\n');
}

export function currentCommit(projectDir) {
  const result = git(['rev-parse', '--short', 'HEAD'], projectDir);
  return result.ok ? result.out : 'unknown';
}

export function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function initProject(projectDir) {
  const created = [];
  const configPath = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    created.push(CONFIG_FILE);
  }
  const ignorePath = path.join(projectDir, '.gitignore');
  const ignoreText = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  if (!ignoreText.split(/\r?\n/).includes(`${STATE_DIR}/`)) {
    const separator = ignoreText && !ignoreText.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(ignorePath, `${separator}${STATE_DIR}/\n`);
    created.push(`.gitignore (+${STATE_DIR}/)`);
  }
  return created;
}
