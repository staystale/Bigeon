// Unreachable remote is reported, not hidden as "nothing new".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cli, run, makeClone, setupRemote } from './helpers.ts';

function bigeon(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return run('node', [cli, ...args], cwd);
}

test('watch reports an unreachable remote instead of nothing new', () => {
  const { root, remote } = setupRemote('bigeon-');
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
  const { root, remote } = setupRemote('bigeon-');
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
