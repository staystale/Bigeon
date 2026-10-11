// bigeon wipe: delete the conversation safely, then start fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bigeon, run, makeClone, setupPair, setupRemote } from './helpers.ts';

function heads(repo: string, cwd: string): string {
  return run('git', ['ls-remote', '--heads', repo], cwd).stdout;
}

function assertWiped(folder: string): void {
  const state = path.join(folder, '.bigeon');
  assert.equal(fs.existsSync(path.join(state, 'comms')), false);
  assert.equal(fs.existsSync(path.join(state, 'comms-repo')), false);
  for (const name of ['seen-tasks.json', 'seen-results.json', 'in-progress.json']) {
    assert.equal(fs.existsSync(path.join(state, name)), false, name);
  }
}

function seedState(folder: string): void {
  fs.mkdirSync(path.join(folder, '.bigeon'), { recursive: true });
  for (const name of ['seen-tasks.json', 'seen-results.json', 'in-progress.json']) {
    fs.writeFileSync(path.join(folder, '.bigeon', name), '[]');
  }
}

test('wipe in worktree mode deletes everything and a new task starts clean', () => {
  const { root, foreman } = setupPair('bigeon-wipe-');
  const remote = path.join(root, 'remote.git');
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'one').status, 0);
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'two').status, 0);
  seedState(foreman);
  assert.match(heads(remote, foreman), /agent-comms/);

  const wiped = bigeon(foreman, 'wipe', '--yes');
  assert.equal(wiped.status, 0, wiped.stderr + wiped.stdout);
  assert.match(wiped.stdout, /Run bigeon wipe on every other machine too/);
  assert.doesNotMatch(heads(remote, foreman), /agent-comms/);
  assert.equal(run('git', ['rev-parse', '--verify', '--quiet', 'agent-comms'], foreman).status, 1);
  assertWiped(foreman);
  assert.match(run('git', ['rev-parse', '--verify', '--quiet', 'main'], foreman).stdout, /\w/);

  const sent = bigeon(foreman, 'send', 'task', '--text', 'new');
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /Sent task 001/);
  const count = run('git', ['rev-list', '--count', 'agent-comms'], remote).stdout.trim();
  assert.equal(count, '2');
});

test('wipe in commsRepo mode deletes the separate repo branch and leaves the project repo alone', () => {
  const { root, remote } = setupRemote('bigeon-wipe-');
  const commsBare = path.join(root, 'comms.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', commsBare], root);
  const foreman = makeClone(root, remote, 'foreman');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node -e 0', commsRepo: commsBare }));
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'one').status, 0);
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'two').status, 0);
  seedState(foreman);
  const projectHeads = heads(remote, foreman);

  const wiped = bigeon(foreman, 'wipe', '--yes');
  assert.equal(wiped.status, 0, wiped.stderr + wiped.stdout);
  assert.doesNotMatch(heads(commsBare, foreman), /agent-comms/);
  assert.equal(heads(remote, foreman), projectHeads);
  assertWiped(foreman);

  const sent = bigeon(foreman, 'send', 'task', '--text', 'new');
  assert.match(sent.stdout, /Sent task 001/);
  assert.equal(run('git', ['rev-list', '--count', 'agent-comms'], commsBare).stdout.trim(), '2');
});

test('wipe refuses while a worker loop is running here', () => {
  const { root, foreman } = setupPair('bigeon-wipe-');
  const remote = path.join(root, 'remote.git');
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'one').status, 0);
  fs.writeFileSync(path.join(foreman, '.bigeon', 'worker.lock'), JSON.stringify({ pid: process.pid }));
  const out = bigeon(foreman, 'wipe', '--yes');
  assert.equal(out.status, 1);
  assert.match(out.stdout + out.stderr, /stop the worker loop/);
  assert.match(heads(remote, foreman), /agent-comms/);
});

test('wipe without --yes and without a terminal refuses', () => {
  const { root, foreman } = setupPair('bigeon-wipe-');
  const remote = path.join(root, 'remote.git');
  assert.equal(bigeon(foreman, 'send', 'task', '--text', 'one').status, 0);
  const out = bigeon(foreman, 'wipe');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /add --yes/);
  assert.match(heads(remote, foreman), /agent-comms/);
});
