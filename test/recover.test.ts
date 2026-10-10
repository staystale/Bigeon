// Recovery tests: a crashed worker must not lose its task, and a rerun starts clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cli, run, makeClone, setupRemote, killTree, waitGone } from './helpers.ts';

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
    maxTries: 3,
    workerTimeoutSeconds: 2,
  }));
  return { root, foreman, worker };
}

function setConfig(worker: string, values: Record<string, unknown>): void {
  const configPath = path.join(worker, 'bigeon.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ...values }));
}

// Simulated crash: the worker is killed before it can report anything.
async function crashWorker(worker: string, foreman: string, killAgent = true, ready?: () => boolean): Promise<void> {
  const child = spawn('node', [cli, 'worker', '--once'], { cwd: worker, detached: process.platform !== 'win32', stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const started = path.join(worker, 'started.txt');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(started) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const appeared = fs.existsSync(started);
  let isReady = true;
  if (ready) {
    while (!ready() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    isReady = ready();
  }
  // killAgent false: only the worker dies, so its agent is left running like a real crash.
  if (killAgent) killTree(child.pid as number);
  else child.kill('SIGKILL');
  await exited;
  assert.equal(appeared, true, 'agent never wrote started.txt');
  assert.equal(isReady, true, 'crash condition never became ready');
  assert.equal(run('node', [cli, 'watch', 'results', '--once'], foreman).status, 2);
}

test('a task interrupted mid-run is done again on the next start', async () => {
  const { foreman, worker } = setupPair('bigeon-recover-');
  fs.writeFileSync(path.join(worker, 'check.js'), "process.exit(require('fs').existsSync('done.txt')?0:1);");
  fs.writeFileSync(path.join(worker, 'agent.js'), `require('fs').writeFileSync('started.txt','x');\n${HANG}`);
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write done.txt'], foreman).status, 0);

  await crashWorker(worker, foreman);

  fs.writeFileSync(path.join(worker, 'agent.js'), "require('fs').writeFileSync('done.txt','x');");
  const again = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /task 001 received/);
  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: PASS/);
});

test('leftovers from an interrupted run are cleaned before the retry', async () => {
  const { foreman, worker } = setupPair('bigeon-clean-');
  fs.writeFileSync(path.join(worker, 'a.txt'), 'original');
  run('git', ['add', 'a.txt'], worker);
  run('git', ['commit', '--quiet', '-m', 'add a'], worker);
  fs.writeFileSync(path.join(worker, 'check.js'), "process.exit(require('fs').existsSync('ok.txt')?0:1);");
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    `const fs=require('fs');fs.writeFileSync('a.txt','half');fs.writeFileSync('junk.txt','x');fs.writeFileSync('started.txt','x');\n${HANG}`,
  );
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write ok.txt'], foreman).status, 0);

  await crashWorker(worker, foreman);

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
  assert.match(done.stdout, /already has a PASS result/);
  assert.equal(fs.existsSync(path.join(worker, 'ran.txt')), false);
});

test('a task with an incomplete result is done again', () => {
  const { foreman, worker } = setupPair('bigeon-incomplete-');
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), "require('fs').writeFileSync('ran.txt','x');");
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: write ran.txt'], foreman).status, 0);
  assert.equal(run('node', [cli, 'send', 'result', '001', '--text', 'half written'], foreman).status, 0);

  const out = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(fs.existsSync(path.join(worker, 'ran.txt')), true);
  assert.match(out.stdout, /incomplete result/);
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

test('a second worker in the same folder refuses to start', () => {
  const { worker } = setupPair('bigeon-lock-');
  fs.mkdirSync(path.join(worker, '.bigeon'), { recursive: true });
  fs.writeFileSync(path.join(worker, '.bigeon', 'worker.lock'), JSON.stringify({ pid: process.pid }));
  const out = run('node', [cli, 'worker', '--once'], worker);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /already running/);
});

test('a stale lock is taken over', () => {
  const { foreman, worker } = setupPair('bigeon-stale-');
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), 'process.exit(0);');
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: nothing'], foreman).status, 0);
  fs.mkdirSync(path.join(worker, '.bigeon'), { recursive: true });
  fs.writeFileSync(path.join(worker, '.bigeon', 'worker.lock'), JSON.stringify({ pid: 999999 }));
  const out = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /took over a stale lock/);
  assert.equal(fs.existsSync(path.join(worker, '.bigeon', 'worker.lock')), false);
});

test('a leftover agent from a crash is stopped on restart', async () => {
  const { foreman, worker } = setupPair('bigeon-leftover-');
  setConfig(worker, { workerTimeoutSeconds: 60 });
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    "const { spawn } = require('child_process');\n" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });\n" +
      "require('fs').writeFileSync('grandchild.pid', String(c.pid));\n" +
      "require('fs').writeFileSync('agent.pid', String(process.pid));\n" +
      "require('fs').writeFileSync('started.txt','x');\n" +
      HANG,
  );
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: nothing'], foreman).status, 0);

  const pids: number[] = [];
  try {
    // On Windows wait until the marker has recorded the agent's process tree.
    const treeRecorded = (): boolean => {
      try {
        const marker: unknown = JSON.parse(fs.readFileSync(path.join(worker, '.bigeon', 'in-progress.json'), 'utf8'));
        const recorded = (marker as { agentPids?: unknown }).agentPids;
        const agent = Number(fs.readFileSync(path.join(worker, 'agent.pid'), 'utf8'));
        return Array.isArray(recorded) && recorded.includes(agent);
      } catch {
        return false;
      }
    };
    await crashWorker(worker, foreman, false, process.platform === 'win32' ? treeRecorded : undefined);
    const agentPid = Number(fs.readFileSync(path.join(worker, 'agent.pid'), 'utf8'));
    const grandchildPid = Number(fs.readFileSync(path.join(worker, 'grandchild.pid'), 'utf8'));
    pids.push(agentPid, grandchildPid);

    fs.writeFileSync(path.join(worker, 'agent.js'), 'process.exit(0);');
    const again = run('node', [cli, 'worker', '--once'], worker);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /stopped leftover agent/);

    assert.equal(await waitGone(agentPid, 5000), true, 'agent process was still running after the restart');
    assert.equal(await waitGone(grandchildPid, 5000), true, 'grandchild process was still running after the restart');
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

test('a task interrupted more than maxTries times is reported as FAIL', async () => {
  const { foreman, worker } = setupPair('bigeon-giveup-');
  setConfig(worker, { maxTries: 2 });
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), `require('fs').writeFileSync('started.txt','x');\n${HANG}`);
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);

  await crashWorker(worker, foreman);
  // The next start stashes started.txt; remove it so the second crash waits for a fresh one.
  fs.rmSync(path.join(worker, 'started.txt'), { force: true });
  await crashWorker(worker, foreman);

  fs.writeFileSync(path.join(worker, 'agent.js'), "require('fs').writeFileSync('ran.txt','x');");
  const again = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(again.status, 1, again.stderr + again.stdout);
  assert.equal(fs.existsSync(path.join(worker, 'ran.txt')), false);
  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Status: FAIL/);
  assert.match(result.stdout, /interrupted 2 times, giving up/);
});

test('the result says when leftovers were stashed', async () => {
  const { foreman, worker } = setupPair('bigeon-stashnote-');
  setConfig(worker, { maxTries: 3 });
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(
    path.join(worker, 'agent.js'),
    `const fs=require('fs');fs.writeFileSync('notes.txt','x');fs.writeFileSync('started.txt','x');\n${HANG}`,
  );
  assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);

  await crashWorker(worker, foreman);

  fs.writeFileSync(path.join(worker, 'agent.js'), 'process.exit(0);');
  const again = run('node', [cli, 'worker', '--once'], worker);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  const result = run('node', [cli, 'watch', 'results', '--once'], foreman);
  assert.match(result.stdout, /Stashed: leftovers/);
});

test('an old pid from before a restart is not stopped', () => {
  const { foreman, worker } = setupPair('bigeon-reboot-');
  setConfig(worker, { maxTries: 3 });
  fs.writeFileSync(path.join(worker, 'check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(worker, 'agent.js'), 'process.exit(0);');
  const child = spawn('node', ['-e', HANG], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(worker, '.bigeon'), { recursive: true });
    fs.writeFileSync(
      path.join(worker, '.bigeon', 'in-progress.json'),
      JSON.stringify({ id: '001', agentPid: child.pid, attempts: 1, bootTime: 0 }),
    );
    assert.equal(run('node', [cli, 'send', 'task', '--text', 'Goal: anything'], foreman).status, 0);

    const out = run('node', [cli, 'worker', '--once'], worker);
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.match(out.stdout, /machine restarted/);
    assert.equal(child.exitCode, null);
    assert.doesNotThrow(() => process.kill(child.pid as number, 0));
  } finally {
    child.kill();
  }
});
