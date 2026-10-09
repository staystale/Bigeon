// Recovery tests: a crashed worker must not lose its task, and a rerun starts clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, run, makeClone, setupRemote } from './helpers.ts';

const HANG = "setInterval(()=>{},1000);\n";

function setupPair(prefix: string): { root: string; foreman: string; worker: string } {
  const { root, remote } = setupRemote(prefix);
  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  // Test scaffolding is ignored (committed locally only) so a stash of leftovers leaves it in place.
  fs.writeFileSync(path.join(worker, '.gitignore'), 'agent.js\ncheck.js\nbigeon.config.json\n.bigeon/\n');
  run('git', ['add', '.gitignore'], worker);
  run('git', ['commit', '--quiet', '-m', 'ignore scaffolding'], worker);
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), JSON.stringify({ checkCommand: 'node check.js' }));
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), JSON.stringify({
    checkCommand: 'node check.js',
    workerCommand: 'node agent.js',
    pollSeconds: 1,
    maxTries: 1,
    workerTimeoutSeconds: 2,
  }));
  return { root, foreman, worker };
}

// Simulated crash: the worker is killed before it can report anything.
function crashWorker(worker: string, foreman: string): void {
  run('node', [cli, 'worker', '--once'], worker, 1000);
  assert.equal(run('node', [cli, 'watch', 'results', '--once'], foreman).status, 2);
}

test('a task interrupted mid-run is done again on the next start', () => {
  const { foreman, worker } = setupPair('bigeon-recover-');
  fs.writeFileSync(path.join(worker, 'check.js'), "process.exit(require('fs').existsSync('done.txt')?0:1);");
  fs.writeFileSync(path.join(worker, 'agent.js'), `require('fs').writeFileSync('started.txt','x');\n${HANG}`);
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write done.txt'], foreman).status, 0);

  crashWorker(worker, foreman);

  fs.writeFileSync(path.join(worker, 'agent.js'), "require('fs').writeFileSync('done.txt','x');");
  const again = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /task 001 received/);
  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: PASS/);
});

test('leftovers from an interrupted run are cleaned before the retry', () => {
  const { foreman, worker } = setupPair('bigeon-clean-');
  fs.writeFileSync(path.join(worker, 'a.txt'), 'original');
  run('git', ['add', 'a.txt'], worker);
  run('git', ['commit', '--quiet', '-m', 'add a'], worker);
  fs.writeFileSync(path.join(worker, 'check.js'), "process.exit(require('fs').existsSync('ok.txt')?0:1);");
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    `const fs=require('fs');fs.writeFileSync('a.txt','half');fs.writeFileSync('junk.txt','x');\n${HANG}`,
  );
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write ok.txt'], foreman).status, 0);

  crashWorker(worker, foreman);

  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    "const fs=require('fs');if(fs.readFileSync('a.txt','utf8')==='original'&&!fs.existsSync('junk.txt'))fs.writeFileSync('ok.txt','x');",
  );
  const again = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /stashing leftovers/);
  assert.match(run('git', ['stash', 'list'], worker).stdout, /leftovers from interrupted task 001/);
  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: PASS/);
});

test('a task that already has a result is not redone', () => {
  const { foreman, worker } = setupPair('bigeon-done-');
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), "require('fs').writeFileSync('ran.txt','x');");
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write ran.txt'], foreman).status, 0);
  assert.equal(run('node', [cli, 'send', 'result', '001', '--text', 'Status: PASS'], foreman).status, 0);

  const done = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.match(done.stdout, /already has a result/);
  assert.equal(fs.existsSync(path.join(worker, 'ran.txt')), false);
});

test('uncommitted work is left alone when nothing was interrupted', () => {
  const { foreman, worker } = setupPair('bigeon-alone-');
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'notes.txt'), 'mine');
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: nothing'], foreman).status, 0);

  const out = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(fs.existsSync(path.join(worker, 'notes.txt')), true);
  assert.doesNotMatch(out.stdout, /stashing leftovers/);
});
