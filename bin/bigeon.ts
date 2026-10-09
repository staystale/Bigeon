#!/usr/bin/env node
// Bigeon command line. Run from inside the project you want to work on.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, runCheck, formatCheck, sleep, resultNoteText, initProject, requireGit,
} from '../src/lib.ts';
import { sendNote, findNewNote } from '../src/comms.ts';
import { runWorker } from '../src/worker.ts';
import type { ParsedArguments, NoteKind } from '../src/types.ts';

const HELP = `Bigeon - a carrier pigeon for code. Passes short notes between agents through git.

Usage (run inside your project):
  bigeon init                              create bigeon.config.json, ignore .bigeon/
  bigeon check                             run checkCommand, print PASS or FAIL + first error lines
  bigeon send task [--file F | --text T]   foreman: send a new task (text from stdin if neither)
  bigeon send result ID [--file F | --text T]
  bigeon report ID [--tries N] [--summary T]
                                           worker: run the check, write the result note, push it
  bigeon worker [--once]                   worker: loop forever. Wait for a task, run workerCommand
                                           (your agent, e.g. the Cline CLI) with the task on stdin,
                                           run the check, report. Needs workerCommand in the config.
  bigeon watch tasks|results [--once] [--timeout MINUTES]
                                           wait for a new note, print it, exit 0
                                           (exit 2 = nothing new, so the model is not woken)
`;

function parseArguments(argumentList: string[]): ParsedArguments {
  const positional: string[] = [];
  const flags: ParsedArguments['flags'] = {};
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index] as string; // index is within bounds
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const next = argumentList[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        index += 1;
      }
    } else {
      positional.push(argument);
    }
  }
  return { positional, flags };
}

function readBody(flags: ParsedArguments['flags']): string {
  if (typeof flags.text === 'string') return flags.text;
  if (typeof flags.file === 'string') return fs.readFileSync(flags.file, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

async function main(): Promise<number> {
  const projectDir = process.cwd();
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArguments(rest);

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return 0;
  }

  if (command === 'init') {
    const created = initProject(projectDir);
    console.log(created.length ? `Created: ${created.join(', ')}` : 'Already set up.');
    return 0;
  }

  const config = loadConfig(projectDir);

  if (['send', 'report', 'watch', 'worker'].includes(command)) requireGit();

  if (command === 'check') {
    const result = runCheck(projectDir, config);
    console.log(formatCheck(result));
    return result.status === 'PASS' ? 0 : 1;
  }

  if (command === 'send') {
    const [kind, id] = positional;
    if (kind !== 'task' && kind !== 'result') throw new Error('send needs "task" or "result"');
    const noteId = sendNote(projectDir, config, kind, id, readBody(flags));
    console.log(`Sent ${kind} ${noteId}`);
    return 0;
  }

  if (command === 'report') {
    const [id] = positional;
    if (!id) throw new Error('report needs the task id, e.g. bigeon report 001');
    const result = runCheck(projectDir, config);
    const tries = typeof flags.tries === 'string' ? Number(flags.tries) : 1;
    const summary = typeof flags.summary === 'string' ? flags.summary : '';
    sendNote(projectDir, config, 'result', id, resultNoteText(projectDir, result, tries, summary));
    console.log(`Reported ${result.status} for task ${id}`);
    return result.status === 'PASS' ? 0 : 1;
  }

  if (command === 'worker') {
    return await runWorker(projectDir, config, fileURLToPath(import.meta.url), { once: Boolean(flags.once) });
  }

  if (command === 'watch') {
    const [target] = positional;
    const kind: NoteKind | null = target === 'tasks' ? 'task' : target === 'results' ? 'result' : null;
    if (!kind) throw new Error('watch needs "tasks" or "results"');
    const deadline = typeof flags.timeout === 'string' ? Date.now() + Number(flags.timeout) * 60000 : null;
    for (;;) {
      const note = findNewNote(projectDir, config, kind);
      if (note) {
        console.log(`# ${kind} ${note.id}\n${note.text}`);
        return 0;
      }
      if (flags.once || (deadline && Date.now() >= deadline)) return 2;
      sleep(config.pollSeconds * 1000);
    }
  }

  console.error(`Unknown command: ${command}\n\n${HELP}`);
  return 64;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`bigeon: ${(error as Error).message}`);
  process.exitCode = 1;
}
