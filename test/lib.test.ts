// pickErrorLines: FAIL results show the failure, not the first lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickErrorLines, loadConfig } from '../src/lib.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configDir(config?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-cfg-'));
  if (config) fs.writeFileSync(path.join(dir, 'bigeon.config.json'), JSON.stringify(config));
  return dir;
}

test('loadConfig rejects bad numbers and accepts good ones', () => {
  assert.throws(() => loadConfig(configDir({ pollSeconds: 'abc' })), /"pollSeconds" must be a number above 0/);
  assert.throws(() => loadConfig(configDir({ maxTries: 0 })), /"maxTries"/);
  assert.equal(loadConfig(configDir({ heartbeatMinutes: 0 })).heartbeatMinutes, 0);
  assert.doesNotThrow(() => loadConfig(configDir()));
});

test('pickErrorLines: strong marker window with 2 lines of context', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `✔ test ${i + 1} passes`);
  lines.push('✖ broken test', '  AssertionError: 1 !== 2', 'ℹ fail 1');
  const { shown, hidden } = pickErrorLines(lines, 20);
  assert.ok(shown.includes('✖ broken test'));
  assert.ok(shown.includes('  AssertionError: 1 !== 2'));
  assert.equal(shown[0], '✔ test 29 passes');
  assert.equal(hidden, lines.length - shown.length);
});

test('pickErrorLines: weak marker only', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `plain ${i}`);
  lines.push('something failed here');
  const { shown } = pickErrorLines(lines, 5);
  assert.ok(shown.includes('something failed here'));
});

test('pickErrorLines: zero summaries do not count, last lines shown', () => {
  const lines = ['ℹ pass 5', 'ℹ fail 0', ...Array.from({ length: 10 }, (_, i) => `plain ${i}`)];
  const { shown, hidden } = pickErrorLines(lines, 3);
  assert.deepEqual(shown, ['plain 7', 'plain 8', 'plain 9']);
  assert.equal(hidden, 9);
});

test('pickErrorLines: fewer lines than count shows all', () => {
  const lines = ['a', 'b', 'c'];
  const { shown, hidden } = pickErrorLines(lines, 10);
  assert.deepEqual(shown, lines);
  assert.equal(hidden, 0);
});
