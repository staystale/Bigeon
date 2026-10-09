// Unreachable remote is reported, not hidden as "nothing new".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bigeon.ts');

function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function bigeon(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return run('node', [cli, ...args], cwd);
}

function makeClone(root: string, remote: string, name: string): string {
  const dir = path.join(root, name);
  run('git', ['clone', '--quiet', remote, dir], root);
  run('git', ['config', 'user.name', name], dir);
  run('git', ['config', 'user.email', `${name}@example.invalid`], dir);
  return dir;
}

function setup(): { root: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-'));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);

  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);
  return { root, remote };
}

test('watch reports an unreachable remote instead of nothing new', () => {
  const { root, remote } = setup();
  const foreman = makeClone(root, remote, 'foreman');
  bigeon(foreman, 'init');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node -e 0' }));

  assert.equal(bigeon(foreman, 'watch', 'tasks', '--once').status, 2);
  run('git', ['remote', 'set-url', 'origin', path.join(root, 'missing.git')], foreman);
  const broken = bigeon(foreman, 'watch', 'tasks', '--once');
  assert.equal(broken.status, 3, broken.stderr);
  assert.match(broken.stderr, /cannot reach origin/);
});

test('worker --once reports an unreachable remote', () => {
  const { root, remote } = setup();
  const worker = makeClone(root, remote, 'worker');
  bigeon(worker, 'init');
  fs.writeFileSync(
    path.join(worker, 'bigeon.config.json'),
    JSON.stringify({ checkCommand: 'node -e 0', workerCommand: 'node -e 0', pollSeconds: 1 }),
  );

  assert.equal(bigeon(worker, 'worker', '--once').status, 2);
  run('git', ['remote', 'set-url', 'origin', path.join(root, 'missing.git')], worker);
  const broken = bigeon(worker, 'worker', '--once');
  assert.equal(broken.status, 3, broken.stderr);
}
);
