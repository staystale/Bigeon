// Bigeon comms: notes travel on a git branch kept in a hidden worktree,
// so the project's own working tree and branch are never disturbed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, mustGit, STATE_DIR } from './lib.ts';
import type { Config, Note, NoteKind } from './types.ts';

export function commsDir(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, 'comms');
}

function hasRemote(workingDir: string, config: Config): boolean {
  return git(['remote', 'get-url', config.remote], workingDir).ok;
}

export function ensureComms(projectDir: string, config: Config): string {
  const dir = commsDir(projectDir);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;

  const { remote, commsBranch } = config;
  const remoteExists = hasRemote(projectDir, config);
  if (remoteExists) git(['fetch', remote], projectDir);
  const remoteRef = `${remote}/${commsBranch}`;
  const remoteHasBranch = remoteExists && git(['rev-parse', '--verify', '--quiet', remoteRef], projectDir).ok;
  const localHasBranch = git(['rev-parse', '--verify', '--quiet', commsBranch], projectDir).ok;
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (remoteHasBranch) {
    mustGit(['worktree', 'add', '-B', commsBranch, dir, remoteRef], projectDir);
  } else if (localHasBranch) {
    mustGit(['worktree', 'add', dir, commsBranch], projectDir);
  } else {
    mustGit(['worktree', 'add', '--detach', dir], projectDir);
    mustGit(['checkout', '--orphan', commsBranch], dir);
    git(['rm', '-rf', '--quiet', '.'], dir);
    for (const folder of ['tasks', 'results']) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, '.gitkeep'), '');
    }
    mustGit(['add', '.'], dir);
    mustGit(['commit', '--quiet', '-m', 'bigeon: start comms branch'], dir);
    if (remoteExists) mustGit(['push', '--quiet', '-u', remote, commsBranch], dir);
  }
  return dir;
}

export class RemoteError extends Error {}

function pullComms(dir: string, config: Config): void {
  if (!hasRemote(dir, config)) return;
  const result = git(['pull', '--quiet', '--rebase', '--autostash', config.remote, config.commsBranch], dir);
  if (!result.ok) throw new RemoteError(`cannot reach ${config.remote}: ${result.err || result.out}`);
}

function folderFor(kind: NoteKind): string {
  if (kind === 'task') return 'tasks';
  if (kind === 'result') return 'results';
  throw new Error(`kind must be "task" or "result", got "${kind}"`);
}

function padId(id: string | number): string {
  return String(id).padStart(3, '0');
}

function nextTaskId(dir: string): string {
  const taken = fs.readdirSync(path.join(dir, 'tasks'))
    .map((name) => parseInt(name, 10))
    .filter((number) => Number.isFinite(number));
  return padId((taken.length ? Math.max(...taken) : 0) + 1);
}

// Write a note, commit it and push it. Returns the note's id.
export function sendNote(
  projectDir: string,
  config: Config,
  kind: NoteKind,
  id: string | number | null | undefined,
  text: string,
): string {
  const dir = ensureComms(projectDir, config);
  pullComms(dir, config);
  const folder = folderFor(kind);
  let noteId: string;
  if (id) {
    noteId = padId(id);
  } else if (kind === 'task') {
    noteId = nextTaskId(dir);
  } else {
    throw new Error('A result needs the id of the task it answers');
  }
  const relativePath = path.join(folder, `${noteId}.md`);
  fs.writeFileSync(path.join(dir, relativePath), text.endsWith('\n') ? text : `${text}\n`);
  mustGit(['add', relativePath], dir);
  // A retry after a failed push finds the note already committed.
  if (!git(['diff', '--cached', '--quiet'], dir).ok) {
    mustGit(['commit', '--quiet', '-m', `bigeon: ${kind} ${noteId}`], dir);
  }

  if (!hasRemote(dir, config)) return noteId;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (git(['push', '--quiet', config.remote, config.commsBranch], dir).ok) return noteId;
    pullComms(dir, config);
  }
  throw new Error('Could not push the note after 3 attempts');
}

function seenFile(projectDir: string, kind: NoteKind): string {
  return path.join(projectDir, STATE_DIR, `seen-${folderFor(kind)}.json`);
}

function readSeen(projectDir: string, kind: NoteKind): string[] {
  try {
    return JSON.parse(fs.readFileSync(seenFile(projectDir, kind), 'utf8'));
  } catch {
    return [];
  }
}

// A note counts as seen by name AND content, so an updated note (e.g. a retried result) shows up again.
function noteKey(name: string, text: string): string {
  return `${name}:${createHash('sha1').update(text).digest('hex')}`;
}

// Look for a note not shown yet. Returns { id, text } or null.
export function findNewNote(projectDir: string, config: Config, kind: NoteKind): Note | null {
  const dir = ensureComms(projectDir, config);
  pullComms(dir, config);
  const folder = path.join(dir, folderFor(kind));
  const seen = readSeen(projectDir, kind);
  const fresh = fs.readdirSync(folder)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(folder, name), 'utf8');
      return { name, text, key: noteKey(name, text) };
    })
    .filter((note) => !seen.includes(note.key));
  const note = fresh[0];
  if (!note) return null;
  fs.mkdirSync(path.join(projectDir, STATE_DIR), { recursive: true });
  fs.writeFileSync(seenFile(projectDir, kind), JSON.stringify([...seen, note.key]));
  return { id: note.name.replace(/\.md$/, ''), text: note.text };
}
