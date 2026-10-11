// Bigeon Linux/macOS guard: runs the worker agent in its own process group and kills that whole
// group as soon as the worker is gone, the agent ends, or the guard is told to stop.
// Usage: guard-posix.ts <workerPid> <base64 of the worker command, UTF-8>
// Known limit: a process that calls setsid itself leaves the agent's group and is not caught.
import { spawn } from 'node:child_process';

const workerPid = Number(process.argv[2]);
const command = Buffer.from(process.argv[3] ?? '', 'base64').toString('utf8');

const agent = spawn(command, { shell: true, detached: true, stdio: 'inherit' });

// The agent leads its own process group, with the agent's pid as the group id. A group id cannot be
// reused while any member is alive, so killing it is safe; ESRCH means the group is already empty.
function killGroup(): void {
  if (agent.pid === undefined) return;
  try {
    process.kill(-agent.pid, 'SIGKILL');
  } catch {
    // group already empty
  }
}

function stop(code: number): never {
  killGroup();
  process.exit(code);
}

agent.on('error', () => stop(1));
agent.on('exit', (code) => stop(code ?? 1));

setInterval(() => {
  try {
    process.kill(workerPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop(1);
  }
}, 1000);

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => stop(1));
}
