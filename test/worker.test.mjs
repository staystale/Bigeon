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
});
