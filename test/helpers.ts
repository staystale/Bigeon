// Shared test helpers (not a test file: the npm test glob is "test/*.test.*").
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bigeon.ts');

export function run(command: string, args: string[], cwd: string, timeout?: number): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
}

export function makeClone(root: string, remote: string, name: string): string {
  const dir = path.join(root, name);
  run('git', ['clone', '--quiet', remote, dir], root);
  run('git', ['config', 'user.name', name], dir);
  run('git', ['config', 'user.email', `${name}@example.invalid`], dir);
  // The fake agent and check are test scaffolding: keep them ignored so the worker's clean step leaves them alone.
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'agent.js\ncheck.js\nbigeon.config.json\n.bigeon/\n');
  return dir;
}

// A temp folder with a bare remote whose main branch holds one seed commit.
export function setupRemote(prefix: string): { root: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);
  return { root, remote };
}
