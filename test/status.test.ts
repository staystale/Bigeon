// Worker heartbeat and `bigeon status`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, run, setupPair as sharedSetupPair } from './helpers.ts';
import { describeStatus } from '../src/worker.ts';

function statusText(state: string, lastSeen: Date): string {
  return `State: ${state}\nSince: ${lastSeen.toISOString()}\nLast seen: ${lastSeen.toISOString()}\nVersion: abc1234\n`;
}

test('describeStatus: fresh idle is alive', () => {
  const now = Date.now();
  const result = describeStatus(statusText('idle', new Date(now - 60000)), now, 10);
  assert.equal(result.exitCode, 0);
  assert.match(result.line, /worker: idle/);
});

test('describeStatus: old Last seen means down', () => {
  const now = Date.now();
  const result = describeStatus(statusText('idle', new Date(now - 45 * 60000)), now, 10);
  assert.equal(result.exitCode, 4);
  assert.match(result.line, /seems down/);
});

test('describeStatus: stopped', () => {
  const now = Date.now();
  const result = describeStatus(statusText('stopped', new Date(now)), now, 10);
  assert.equal(result.exitCode, 4);
  assert.match(result.line, /worker stopped/);
});

test('describeStatus: garbage is unreadable', () => {
  const result = describeStatus('hello', Date.now(), 10);
  assert.equal(result.exitCode, 4);
  assert.match(result.line, /unreadable/);
});

function setupPair(prefix: string, heartbeatMinutes?: number): { foreman: string; worker: string } {
  const workerConfig: Record<string, unknown> = {
    checkCommand: 'node check.js',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
  };
  if (heartbeatMinutes !== undefined) workerConfig.heartbeatMinutes = heartbeatMinutes;
  const { foreman, worker } = sharedSetupPair(prefix, workerConfig);
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  return { foreman, worker };
}

test('status shows the task while the agent works', () => {
  const { foreman, worker } = setupPair('bigeon-status-a-');
  const agent = `const {spawnSync}=require('child_process');process.stdin.resume();process.stdin.on('end',()=>{`
    + `const r=spawnSync('node',[${JSON.stringify(cli)},'status'],{encoding:'utf8'});`
    + `require('fs').writeFileSync('status.txt',r.stdout)});`;
  fs.writeFileSync(path.join(worker, 'agent.js'), agent);
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.match(fs.readFileSync(path.join(worker, 'status.txt'), 'utf8'), /working on 001 \(try 1 of/);
});

test('status says stopped after the loop ends', () => {
  const { foreman, worker } = setupPair('bigeon-status-b-');
  fs.writeFileSync(path.join(worker, 'agent.js'), "process.stdin.resume();process.stdin.on('end',()=>{});");
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const status = run('node', [cli, 'status'], foreman);
  assert.equal(status.status, 4, status.stderr + status.stdout);
  assert.match(status.stdout, /worker stopped/);
});

test('no status yet', () => {
  const { foreman } = setupPair('bigeon-status-c-');
  const status = run('node', [cli, 'status'], foreman);
  assert.equal(status.status, 2, status.stderr + status.stdout);
  assert.match(status.stdout, /no worker status yet/);
});

test('heartbeatMinutes 0 writes no status', () => {
  const { foreman, worker } = setupPair('bigeon-status-d-', 0);
  fs.writeFileSync(path.join(worker, 'agent.js'), "process.stdin.resume();process.stdin.on('end',()=>{});");
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const status = run('node', [cli, 'status'], foreman);
  assert.equal(status.status, 2, status.stderr + status.stdout);
  assert.match(status.stdout, /no worker status yet/);
});
