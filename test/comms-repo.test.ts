// commsRepo: notes live in a separate repo, the project repo only gets code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bigeon, run, makeClone, setupRemote } from './helpers.ts';

function setupSeparate(commsRepo?: string): { root: string; foreman: string; worker: string; commsBare: string; remote: string } {
  const { root, remote } = setupRemote('bigeon-');
  const commsBare = path.join(root, 'comms.git');
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', commsBare], root);
  const foreman = makeClone(root, remote, 'foreman');
  const worker = makeClone(root, remote, 'worker');
  const config = JSON.stringify({ checkCommand: 'node -e 0', commsRepo: commsRepo ?? commsBare });
  fs.writeFileSync(path.join(foreman, 'bigeon.config.json'), config);
  fs.writeFileSync(path.join(worker, 'bigeon.config.json'), config);
  return { root, foreman, worker, commsBare, remote };
}

test('notes go to the separate comms repo, not the project repo', () => {
  const { foreman, worker, commsBare, remote } = setupSeparate();
  const sent = bigeon(foreman, 'send', 'task', '--text', 'hi');
  assert.equal(sent.status, 0, sent.stderr);

  const commsHeads = run('git', ['ls-remote', '--heads', commsBare], foreman).stdout;
  assert.match(commsHeads, /refs\/heads\/agent-comms/);
  const tree = run('git', ['ls-tree', '-r', '--name-only', 'agent-comms'], commsBare).stdout;
  assert.match(tree, /tasks\/001\.md/);
  assert.doesNotMatch(run('git', ['ls-remote', '--heads', remote], foreman).stdout, /agent-comms/);

  const seen = bigeon(worker, 'watch', 'tasks', '--once');
  assert.equal(seen.status, 0, seen.stderr);
  assert.match(seen.stdout, /hi/);
});

test('a missing commsRepo is reported', () => {
  const { root, foreman } = setupSeparate('placeholder');
  fs.writeFileSync(
    path.join(foreman, 'bigeon.config.json'),
    JSON.stringify({ checkCommand: 'node -e 0', commsRepo: path.join(root, 'missing.git') }),
  );
  const result = bigeon(foreman, 'send', 'task', '--text', 'hi');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot clone commsRepo/);
});
