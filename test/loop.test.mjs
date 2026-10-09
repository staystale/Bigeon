// End-to-end test: foreman and worker clones talk through a local bare remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bigeon.mjs');

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function bigeon(cwd, ...args) {
  return run('node', [cli, ...args], cwd);
}

function makeClone(root, remote, name) {
  const dir = path.join(root, name);
  run('git', ['clone', '--quiet', remote, dir], root);
  run('git', ['config', 'user.name', name], dir);
  run('git', ['config', 'user.email', `${name}@example.invalid`], dir);
  return dir;
}

test('foreman sends a task, worker fails then passes, foreman reads results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-'));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);

  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);

  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  for (const dir of [foreman, worker]) {
    bigeon(dir, 'init');
    fs.writeFileSync(
      path.join(dir, 'bigeon.config.json'),
      JSON.stringify({ checkCommand: 'node check.js', errorLines: 2 }),
    );
  }
  fs.writeFileSync(path.join(worker, 'check.js'), 'console.error("line1");console.error("line2");console.error("line3");process.exit(1);');

  // Worker has nothing yet.
  const idle = bigeon(worker, 'watch', 'tasks', '--once');
  assert.equal(idle.status, 2, idle.stderr);

  // Foreman sends a task.
  const sent = bigeon(foreman, 'send', 'task', '--text', 'Goal: make check.js pass');
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /Sent task 001/);

  // Worker sees it exactly once.
  const seen = bigeon(worker, 'watch', 'tasks', '--once');
  assert.equal(seen.status, 0, seen.stderr);
  assert.match(seen.stdout, /make check\.js pass/);
  const idleAgain = bigeon(worker, 'watch', 'tasks', '--once');
  assert.equal(idleAgain.status, 2, idleAgain.stderr);

  // Check output is trimmed.
  const failing = bigeon(worker, 'check');
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /FAIL \(exit code 1\)/);
  assert.match(failing.stdout, /more lines hidden/);
  assert.doesNotMatch(failing.stdout, /line3/);

  // Worker reports the failure.
  assert.equal(bigeon(worker, 'report', '001', '--tries', '3').status, 1);
  const failedResult = bigeon(foreman, 'watch', 'results', '--once');
  assert.equal(failedResult.status, 0, failedResult.stderr);
  assert.match(failedResult.stdout, /Status: FAIL/);
  assert.match(failedResult.stdout, /Tries: 3/);

  // Worker fixes it and reports a pass (overwrites result 001).
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  assert.equal(bigeon(worker, 'report', '001', '--summary', 'fixed').status, 0);
  fs.rmSync(path.join(foreman, '.bigeon', 'seen-results.json'));
  const passedResult = bigeon(foreman, 'watch', 'results', '--once');
  assert.match(passedResult.stdout, /Status: PASS/);
  assert.match(passedResult.stdout, /Summary: fixed/);

  // Second task gets the next id.
  assert.match(bigeon(foreman, 'send', 'task', '--text', 'next').stdout, /Sent task 002/);
});
