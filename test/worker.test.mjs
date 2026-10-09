// Worker loop test: a fake agent stands in for Cline.
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

function makeClone(root, remote, name) {
  const dir = path.join(root, name);
  run('git', ['clone', '--quiet', remote, dir], root);
  run('git', ['config', 'user.name', name], dir);
  run('git', ['config', 'user.email', `${name}@example.invalid`], dir);
  return dir;
}

test('worker command runs the agent with the task on stdin, then reports the check result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-worker-'));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);

  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify({
    checkCommand: 'node check.js',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
  }));
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    "let text='';process.stdin.on('data',(c)=>{text+=c});process.stdin.on('end',()=>{require('fs').writeFileSync('out.txt',text);console.log('fake agent saw '+text.length+' chars')});",
  );
  fs.writeFileSync(path.join(worker, 'check.js'), "process.exit(require('fs').existsSync('out.txt')?0:1);");

  const sent = run('node', [cli, 'send', 'task', '--text', 'Goal: write out.txt'], foreman);
  assert.equal(sent.status, 0, sent.stderr);

  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.match(done.stdout, /task 001 received/);
  assert.match(done.stdout, /reported PASS/);
  assert.match(fs.readFileSync(path.join(worker, 'out.txt'), 'utf8'), /Goal: write out\.txt/);

  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: PASS/);
  assert.match(result.stdout, /Tries: 1/);
  assert.match(result.stdout, /Worker said:\r?\nfake agent saw/);
});

test('worker retries a failing check with the failure shown to the agent, then reports tries and agent output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-retry-'));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);

  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify({
    checkCommand: 'node check.js',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
    maxTries: 3,
  }));
  // Agent: first run writes "bad"; if the prompt mentions a failure it writes "good".
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    "let t='';process.stdin.on('data',(c)=>{t+=c});process.stdin.on('end',()=>{const retry=t.includes('This is a retry');require('fs').writeFileSync('value.txt',retry?'good':'bad');console.log(retry?'second go: fixed it':'first go: wrote bad')});",
  );
  fs.writeFileSync(
    path.join(worker, 'check.js'),
    "const v=require('fs').existsSync('value.txt')?require('fs').readFileSync('value.txt','utf8'):'';if(v==='good')process.exit(0);console.error('expected good but found '+v);process.exit(1);",
  );

  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: make value.txt say good'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.match(done.stdout, /try 1 of 3/);
  assert.match(done.stdout, /try 2 of 3/);

  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: PASS/);
  assert.match(result.stdout, /Tries: 2/);
  assert.match(result.stdout, /second go: fixed it/);
});

test('worker gives up after maxTries and reports FAIL with the check errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigeon-giveup-'));
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = makeClone(root, remote, 'seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '--quiet', '-m', 'seed'], seed);
  run('git', ['push', '--quiet', 'origin', 'HEAD:main'], seed);

  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify({
    checkCommand: 'node check.js',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
    maxTries: 2,
  }));
  fs.writeFileSync(path.join(worker, 'agent.js'), "process.stdin.resume();process.stdin.on('end',()=>console.log('I tried'));");
  fs.writeFileSync(path.join(worker, 'check.js'), "console.error('nope, still broken');process.exit(1);");

  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: impossible'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 1, done.stderr + done.stdout);

  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: FAIL/);
  assert.match(result.stdout, /Tries: 2/);
  assert.match(result.stdout, /nope, still broken/);
  assert.match(result.stdout, /Worker said:\r?\nI tried/);
});
