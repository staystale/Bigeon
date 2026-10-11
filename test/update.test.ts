// bigeonUpdate and versionLine: the Bigeon version and "update available".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bigeonUpdate, versionLine } from '../src/lib.ts';
import { makeClone, run, setupRemote } from './helpers.ts';

test('versionLine: up to date', () => {
  assert.equal(versionLine({ version: 'abc1234', behind: 0 }, '/b'), 'Bigeon abc1234 (up to date)');
});

test('versionLine: update available', () => {
  assert.equal(
    versionLine({ version: 'abc1234', behind: 3 }, '/b'),
    'Bigeon abc1234: UPDATE AVAILABLE (3 new commits). Run git pull in /b, then restart.',
  );
});

test('versionLine: unknown', () => {
  assert.equal(versionLine({ version: 'abc1234', behind: null }, '/b'), 'Bigeon abc1234');
});

test('bigeonUpdate: clone one commit behind its remote', () => {
  const { root, remote } = setupRemote('bigeon-update-a-');
  const clone = makeClone(root, remote, 'clone');
  const other = makeClone(root, remote, 'other');
  fs.writeFileSync(path.join(other, 'more.txt'), 'more\n');
  run('git', ['add', '.'], other);
  run('git', ['commit', '--quiet', '-m', 'more'], other);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], other);
  const update = bigeonUpdate(clone);
  assert.equal(update.behind, 1);
  assert.match(update.version, /^[0-9a-f]{7,}$/);
});

test('bigeonUpdate: folder with no upstream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-update-b-'));
  try {
    run('git', ['init', '--quiet'], dir);
    run('git', ['config', 'user.name', 'x'], dir);
    run('git', ['config', 'user.email', 'x@example.invalid'], dir);
    run('git', ['commit', '--quiet', '--allow-empty', '-m', 'one'], dir);
    const update = bigeonUpdate(dir);
    assert.equal(update.behind, null);
    assert.notEqual(update.version, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
