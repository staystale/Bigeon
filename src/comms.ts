// Bigeon comms: notes travel on a git branch kept in a hidden worktree,
// so the project's own working tree and branch are never disturbed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, mustGit, STATE_DIR } from './lib.ts';
import type { Config, Note, NoteKind } from './types.ts';

export function commsDir(projectDir: string, config: Config): string {
  return path.join(projectDir, STATE_DIR, config.commsRepo ? 'comms-repo' : 'comms');
}

// The remote name used inside the comms folder: a clone's own remote is always origin.
function commsRemote(config: Config): string {
  return config.commsRepo ? 'origin' : config.remote;
}

function hasRemote(workingDir: string, config: Config): boolean {
  return git(['remote', 'get-url', commsRemote(config)], workingDir).ok;
}

// Create the orphan comms branch in dir, with empty tasks/ and results/, and push it when there is a remote.
function createOrphanBranch(dir: string, commsBranch: string, remote: string | null): void {
  mustGit(['checkout', '--orphan', commsBranch], dir);
  git(['rm', '-rf', '--quiet', '.'], dir);
  for (const folder of ['tasks', 'results']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, '.gitkeep'), '');
  }
  mustGit(['add', '.'], dir);
  mustGit(['commit', '--quiet', '-m', 'bigeon: start comms branch'], dir);
  if (remote) mustGit(['push', '--quiet', '-u', remote, commsBranch], dir);
}

function ensureCommsClone(projectDir: string, config: Config, dir: string): void {
  const { commsRepo, commsBranch } = config;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const cloned = git(['clone', '--quiet', commsRepo, dir], projectDir);
  if (!cloned.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new RemoteError(`cannot clone commsRepo ${commsRepo}: ${cloned.err || cloned.out}`);
  }
  for (const key of ['user.name', 'user.email']) {
    const value = git(['config', '--get', key], projectDir);
    if (value.ok && value.out.trim()) mustGit(['config', key, value.out.trim()], dir);
  }
  git(['fetch', 'origin'], dir);
  if (git(['rev-parse', '--verify', '--quiet', `origin/${commsBranch}`], dir).ok) {
    mustGit(['checkout', '-B', commsBranch, `origin/${commsBranch}`], dir);
  } else {
    createOrphanBranch(dir, commsBranch, 'origin');
  }
}

export function ensureComms(projectDir: string, config: Config): string {
  const dir = commsDir(projectDir, config);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  if (config.commsRepo) {
    ensureCommsClone(projectDir, config, dir);
    return dir;
  }

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
    createOrphanBranch(dir, commsBranch, remoteExists ? remote : null);
  }
  return dir;
}

export class RemoteError extends Error {}

function pullComms(dir: string, config: Config): void {
  if (!hasRemote(dir, config)) return;
  const result = git(['pull', '--quiet', '--rebase', '--autostash', commsRemote(config), config.commsBranch], dir);
  if (!result.ok) throw new RemoteError(`cannot reach ${commsRemote(config)}: ${result.err || result.out}`);
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

// Commit one file (only if changed) and push it, retrying after a pull.
function commitAndPush(dir: string, config: Config, relativePath: string, message: string): void {
  mustGit(['add', relativePath], dir);
  // A retry after a failed push finds the note already committed.
  if (!git(['diff', '--cached', '--quiet'], dir).ok) {
    mustGit(['commit', '--quiet', '-m', message], dir);
  }

  if (!hasRemote(dir, config)) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (git(['push', '--quiet', commsRemote(config), config.commsBranch], dir).ok) return;
    pullComms(dir, config);
  }
  throw new Error('Could not push the note after 3 attempts');
}

const STATUS_FILE = path.join('status', 'worker.md');

// Write the worker's status file. Never throws: a status write must not stop the loop.
export function writeStatus(projectDir: string, config: Config, text: string): void {
  try {
    const dir = ensureComms(projectDir, config);
    pullComms(dir, config);
    fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(dir, STATUS_FILE), text.endsWith('\n') ? text : `${text}\n`);
    commitAndPush(dir, config, STATUS_FILE, 'bigeon: worker status');
  } catch {
    // ignored on purpose, including RemoteError
  }
}

// The worker's status text, or null when there is none yet.
export function readStatus(projectDir: string, config: Config): string | null {
  const dir = ensureComms(projectDir, config);
  pullComms(dir, config);
  const file = path.join(dir, STATUS_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Write a note, commit it and push it. Returns the note's id.
export function sendNote(
  projectDir: string,
  config: Config,
  kind: NoteKind,
  id: string | number | null | undefined,
  text: string,
): string {
  if (id && !/^\d+$/.test(String(id))) {
    throw new Error(`note id must be a number, e.g. 043 (got "${id}")`);
  }
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
  commitAndPush(dir, config, relativePath, `bigeon: ${kind} ${noteId}`);
  return noteId;
}

// The text of one note (pulled first), or null when there is no such note.
export function readNote(projectDir: string, config: Config, kind: NoteKind, id: string): string | null {
  const dir = ensureComms(projectDir, config);
  pullComms(dir, config);
  const file = path.join(dir, folderFor(kind), `${id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
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
export function findNewNote(
  projectDir: string,
  config: Config,
  kind: NoteKind,
  options: { markSeen?: boolean } = {},
): Note | null {
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
  if (options.markSeen ?? true) appendSeen(projectDir, kind, note.key);
  return { id: note.name.replace(/\.md$/, ''), text: note.text };
}

function appendSeen(projectDir: string, kind: NoteKind, key: string): void {
  const seen = readSeen(projectDir, kind);
  fs.mkdirSync(path.join(projectDir, STATE_DIR), { recursive: true });
  fs.writeFileSync(seenFile(projectDir, kind), JSON.stringify([...seen, key]));
}

// Mark a note as seen once it has been fully handled.
export function markNoteSeen(projectDir: string, kind: NoteKind, note: Note): void {
  appendSeen(projectDir, kind, noteKey(`${note.id}.md`, note.text));
}