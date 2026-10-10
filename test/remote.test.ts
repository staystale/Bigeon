// Unreachable remote is reported, not hidden as "nothing new".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bigeon, run, makeClone, setupRemote } from './helpers.ts';

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

test('watch with a bad --timeout exits 1', () => {
  const { root, remote } = setupRemote('bigeon-');
  const foreman = makeClone(root, remote, 'foreman');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node -e 0' }));
  const result = bigeon(foreman, 'watch', 'results', '--timeout', 'abc');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--timeout needs a number/);
});

test('watch exits 3 when the remote stays unreachable past --timeout', () => {
  const { root, remote } = setupRemote('bigeon-');
  const foreman = makeClone(root, remote, 'foreman');
  fs.writeFileSync(
    path.join(foreman, 'bigeon.config.json'),
    JSON.stringify({ checkCommand: 'node -e 0', pollSeconds: 1 }),
  );
  assert.equal(bigeon(foreman, 'watch', 'results', '--once').status, 2);
  run('git', ['remote', 'set-url', 'origin', path.join(root, 'missing.git')], foreman);
  const result = bigeon(foreman, 'watch', 'results', '--timeout', '0.05');
  assert.equal(result.status, 3, result.stderr);
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
