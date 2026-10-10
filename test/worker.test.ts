// Worker loop test: a fake agent stands in for Cline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, run, makeClone, setupRemote } from './helpers.ts';
import { workerPrompt } from '../src/worker.ts';
import { loadConfig } from '../src/lib.ts';

test('worker command runs the agent with the task on stdin, then reports the check result', () => {
  const { root, remote } = setupRemote('bigeon-worker-');

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
  const { root, remote } = setupRemote('bigeon-retry-');

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
  const { root, remote } = setupRemote('bigeon-giveup-');

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

test('worker timeout stops the agent and the processes it started', async () => {
  const { root, remote } = setupRemote('bigeon-timeout-');

  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node -e 0' }));
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify({
    checkCommand: 'node -e 0',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
    maxTries: 1,
    workerTimeoutSeconds: 2,
  }));
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    "const { spawn } = require('child_process');\n" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });\n" +
      "require('fs').writeFileSync('grandchild.pid', String(c.pid));\n" +
      'setInterval(()=>{},1000);\n',
  );

  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: hang'], foreman).status, 0);
  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.match(done.stdout, /worker agent finished \(timed out\)/);

  const pidFile = path.join(worker, 'grandchild.pid');
  assert.ok(fs.existsSync(pidFile), 'grandchild.pid should exist');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let running = true;
  const deadline = Date.now() + 5000;
  while (running && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (running) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
    assert.fail('grandchild process was still running after the timeout');
  }

  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Summary: worker agent timed out/);
});


test('the worker prompt names the loop pid and forbids stopping it', () => {
  const prompt = workerPrompt('bigeon.ts', loadConfig(process.cwd()), '001', 'Goal: x', '');
  assert.match(prompt, new RegExp(`worker loop running you has pid ${process.pid}`));
  assert.match(prompt, /unless the foreman or the user tells you to/);
  assert.match(prompt, /foreground, one at a time/);
});
