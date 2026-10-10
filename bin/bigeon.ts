#!/usr/bin/env node
// Bigeon command line. Run from inside the project you want to work on.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, runCheck, formatCheck, sleep, resultNoteText, initProject, requireGit,
} from '../src/lib.ts';
import { sendNote, findNewNote, readStatus, RemoteError } from '../src/comms.ts';
import { runWorker, describeStatus } from '../src/worker.ts';
import { accept } from '../src/accept.ts';
import type { ParsedArguments, NoteKind, Note } from '../src/types.ts';

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
  bigeon status                            foreman: show whether the worker is idle, working or down
                                           (exit 0 = alive, 2 = no status yet, 3 = remote unreachable, 4 = stopped or down)
  bigeon watch tasks|results [--once] [--timeout MINUTES]
                                           wait for a new note, print it, exit 0
                                           (exit 2 = nothing new, so the model is not woken, exit 3 = could not reach the remote)
  bigeon accept NNN [--dry-run] [--timeout MINUTES]
                                            foreman: check the result, base and CI of worker/NNN, then push it to main
                                            (exit 0 = accepted, 1 = refused, 3 = could not reach the remote,
                                            5 = CI still running after the timeout, default 15 minutes)
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

  if (['send', 'report', 'watch', 'worker', 'status', 'accept'].includes(command)) requireGit();

  if (command === 'check') {
    const result = await runCheck(projectDir, config);
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
    const result = await runCheck(projectDir, config);
    const tries = typeof flags.tries === 'string' ? Number(flags.tries) : 1;
    const summary = typeof flags.summary === 'string' ? flags.summary : '';
    sendNote(projectDir, config, 'result', id, resultNoteText(projectDir, result, tries, summary));
    console.log(`Reported ${result.status} for task ${id}`);
    return result.status === 'PASS' ? 0 : 1;
  }

  if (command === 'accept') {
    const [id] = positional;
    if (!id) throw new Error('accept needs the task id, e.g. bigeon accept 001');
    const timeoutMinutes = typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined;
    return await accept(projectDir, config, id, {
      dryRun: Boolean(flags['dry-run']),
      timeoutMinutes,
      log: (line) => console.log(line),
    });
  }

  if (command === 'worker') {
    return await runWorker(projectDir, config, fileURLToPath(import.meta.url), { once: Boolean(flags.once) });
  }

  if (command === 'status') {
    let text: string | null;
    try {
      text = readStatus(projectDir, config);
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      console.log(error.message);
      return 3;
    }
    if (text === null) {
      console.log('no worker status yet');
      return 2;
    }
    const described = describeStatus(text, Date.now(), config.heartbeatMinutes);
    console.log(described.line);
    const version = /^Version: .+$/m.exec(text);
    if (version) console.log(version[0]);
    return described.exitCode;
  }

  if (command === 'watch') {
    const [target] = positional;
    const kind: NoteKind | null = target === 'tasks' ? 'task' : target === 'results' ? 'result' : null;
    if (!kind) throw new Error('watch needs "tasks" or "results"');
    const deadline = typeof flags.timeout === 'string' ? Date.now() + Number(flags.timeout) * 60000 : null;
    let lastMessage = '';
    for (;;) {
      let note: Note | null = null;
      try {
        note = findNewNote(projectDir, config, kind);
        if (lastMessage) console.error('[bigeon] reconnected');
        lastMessage = '';
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        if (flags.once) {
          console.error(`bigeon: ${error.message}`);
          return 3;
        }
        if (error.message !== lastMessage) {
          console.error(`[bigeon] ${error.message} (retrying every ${config.pollSeconds}s)`);
          lastMessage = error.message;
        }
        if (deadline && Date.now() >= deadline) return 2;
        sleep(config.pollSeconds * 1000);
        continue;
      }
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
