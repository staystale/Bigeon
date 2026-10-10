// Accept tests: a local bare remote, so the CI step is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, run, makeClone, setupRemote } from './helpers.ts';
import { githubRepo, summarizeChecks } from '../src/accept.ts';

test('githubRepo reads https and ssh GitHub urls only', () => {
  assert.deepEqual(githubRepo('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepo('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepo('git@github.com:o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepo('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.equal(githubRepo('https://example.com/o/r.git'), null);
  assert.equal(githubRepo('/tmp/remote.git'), null);
  assert.equal(githubRepo('C:\\work\\remote.git'), null);
});

test('summarizeChecks reads a check-runs response', () => {
  assert.equal(summarizeChecks({ check_runs: [] }), 'none');
  assert.equal(summarizeChecks(null), 'none');
  assert.equal(summarizeChecks('nope'), 'none');
  assert.equal(summarizeChecks({}), 'none');
  assert.equal(summarizeChecks({ check_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress', conclusion: null },
  ] }), 'pending');
  assert.equal(summarizeChecks({ check_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
  ] }), 'failure');
  assert.equal(summarizeChecks({ check_runs: [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'skipped' },
    { status: 'completed', conclusion: 'neutral' },
  ] }), 'success');
});

// A foreman clone plus a worker branch worker/001 (one commit on top of main) and a result note.
function setup(resultText: string): { root: string; remote: string; foreman: string; branchSha: string; worker: string } {
  const { root, remote } = setupRemote('bigeon-accept-');
  const foreman = makeClone(root, remote, 'foreman');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  const worker = makeClone(root, remote, 'worker');
  run('git', ['checkout', '--quiet', '-b', 'worker/001'], worker);
  fs.writeFileSync(path.join(worker, 'feature.txt'), 'feature\n');
  run('git', ['add', '.'], worker);
  run('git', ['commit', '--quiet', '-m', 'feature'], worker);
  run('git', ['push', '--quiet', 'origin', 'worker/001'], worker);
  const branchSha = run('git', ['rev-parse', 'HEAD'], worker).stdout.trim();
  const text = `${resultText}Commit: ${branchSha.slice(0, 7)}\n`;
  const sent = run('node', [cli, 'send', 'result', '001', '--text', text], foreman);
  assert.equal(sent.status, 0, sent.stderr);
  return { root, remote, foreman, branchSha, worker };
}

function remoteMain(remote: string, root: string): string {
  return run('git', ['rev-parse', 'main'], remote || root).stdout.trim();
}

test('accept pushes a PASS branch on top of main', () => {
  const { root, remote, foreman, branchSha } = setup('Status: PASS\n');
  const result = run('node', [cli, 'accept', '001'], foreman);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /accepted 001/);
  assert.equal(remoteMain(remote, root), branchSha);
});

test('accept pads a short id to three digits', () => {
  const { root, remote, foreman, branchSha } = setup('Status: PASS\n');
  const result = run('node', [cli, 'accept', '1'], foreman);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /accepted 001/);
  assert.equal(remoteMain(remote, root), branchSha);
});

test('accept refuses a branch that changed after its result', () => {
  const { root, remote, foreman, worker } = setup('Status: PASS\n');
  fs.writeFileSync(path.join(worker, 'extra.txt'), 'extra\n');
  run('git', ['add', '.'], worker);
  run('git', ['commit', '--quiet', '-m', 'extra'], worker);
  run('git', ['push', '--quiet', 'origin', 'worker/001'], worker);
  const before = remoteMain(remote, root);
  const result = run('node', [cli, 'accept', '001'], foreman);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /has changed since its result/);
  assert.equal(remoteMain(remote, root), before);
});

test('accept refuses a FAIL result', () => {
  const { root, remote, foreman } = setup('Status: FAIL\n');
  const before = remoteMain(remote, root);
  const result = run('node', [cli, 'accept', '001'], foreman);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /is not PASS/);
  assert.equal(remoteMain(remote, root), before);
});

test('accept refuses a branch made from an older main', () => {
  const { root, remote, foreman } = setup('Status: PASS\n');
  const other = makeClone(root, remote, 'other');
  fs.writeFileSync(path.join(other, 'more.txt'), 'more\n');
  run('git', ['add', '.'], other);
  run('git', ['commit', '--quiet', '-m', 'more'], other);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], other);
  const before = remoteMain(remote, root);
  const result = run('node', [cli, 'accept', '001'], foreman);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /is behind/);
  assert.equal(remoteMain(remote, root), before);
});

test('accept --dry-run changes nothing', () => {
  const { root, remote, foreman } = setup('Status: PASS\n');
  const before = remoteMain(remote, root);
  const result = run('node', [cli, 'accept', '001', '--dry-run'], foreman);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /dry run/);
  assert.equal(remoteMain(remote, root), before);
});

test('accept fails when there is no such branch', () => {
  const { foreman } = setup('Status: PASS\n');
  const result = run('node', [cli, 'accept', '002'], foreman);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /no branch worker\/002/);
});
