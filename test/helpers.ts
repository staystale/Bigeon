// Shared test helpers (not a test file: the npm test glob is "test/*.test.*").
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killPid } from '../src/lib.ts';

export const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bigeon.ts');

export function run(command: string, args: string[], cwd: string, timeout?: number): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
}

export function makeClone(root: string, remote: string, name: string): string {
  const dir = path.join(root, name);
  run('git', ['clone', '--quiet', remote, dir], root);
  run('git', ['config', 'user.name', name], dir);
  run('git', ['config', 'user.email', `${name}@example.invalid`], dir);
  return dir;
}

export function bigeon(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return run('node', [cli, ...args], cwd);
}

const tempRoots: string[] = [];

// Remove every temp folder made by setupRemote when the test process ends.
process.on('exit', () => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore failures
    }
  }
});

// A temp folder with a bare remote whose main branch holds one seed commit.
export function setupRemote(prefix: string): { root: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);
  return { root, remote };
}

// A foreman and a worker clone; the worker gets `config` as its bigeon.config.json.
export function setupPair(
  prefix: string,
  config?: Record<string, unknown>,
): { root: string; foreman: string; worker: string } {
  const { root, remote } = setupRemote(prefix);
  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  if (config !== undefined) fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify(config));
  return { root, foreman, worker };
}

// Merge values into a worker's bigeon.config.json.
export function setConfig(worker: string, values: Record<string, unknown>): void {
  const configPath = path.join(worker, 'bigeon.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ...values }));
}

// Kill a process and all its children (the worker and the agent it started).
export function killTree(pid: number): void {
  try {
    killPid(pid);
  } catch {
    // already gone
  }
}

// Poll every 200 ms until the process no longer exists (true) or ms run out (false).
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

