// Shared types for Bigeon. Type-only file: Node strips it, tsc checks against it.
// Only erasable TypeScript is allowed (no enum, namespace or parameter properties),
// because Node runs these files directly without a build step.

/** Contents of bigeon.config.json after defaults are applied. */
export interface Config {
  /** Shell command that decides PASS (exit 0) or FAIL (anything else). */
  checkCommand: string;
  /** How many error lines a FAIL result carries. */
  errorLines: number;
  /** Worker attempts per task before it reports FAIL. */
  maxTries: number;
  /** Seconds between git polls in watch and worker. */
  pollSeconds: number;
  /** Branch that carries the notes. */
  commsBranch: string;
  /** Git remote both machines push to and pull from. */
  remote: string;
  /** Seconds before the check is stopped and counted as a FAIL. */
  checkTimeoutSeconds: number;
  /** Shell command that starts the worker agent. The prompt goes to its stdin. */
  workerCommand: string;
  /** Seconds before one agent run is stopped. */
  workerTimeoutSeconds: number;
  /** Minutes between worker heartbeat writes to status/worker.md. 0 turns the heartbeat off. */
  heartbeatMinutes: number;
}

export type CheckStatus = 'PASS' | 'FAIL';

/** Short, token-cheap outcome of running checkCommand. */
export interface CheckResult {
  status: CheckStatus;
  /** Exit code, or null when the check timed out or could not start. */
  exitCode: number | null;
  timedOut: boolean;
  /** First errorLines lines of output (empty on PASS). */
  errors: string[];
  /** How many output lines were cut off. */
  hiddenLineCount: number;
}

/** Outcome of a git command run through the git() helper. */
export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** The two kinds of note. Tasks live in tasks/, results in results/. */
export type NoteKind = 'task' | 'result';

/** A note read from the comms branch. */
export interface Note {
  /** Zero-padded id, e.g. "007". */
  id: string;
  text: string;
}

/** Parsed command line: plain words plus --flags. */
export interface ParsedArguments {
  positional: string[];
  flags: Record<string, string | true>;
}

/** Options for the worker loop. */
export interface WorkerOptions {
  /** Handle at most one task, then return. */
  once?: boolean;
  /** Where progress lines go (defaults to console.log). */
  log?: (message: string) => void;
}

/** Outcome of one worker agent run. */
export interface AgentRun {
  /** "exit 0", "exit 1", "timed out", ... */
  exitText: string;
  /** Everything the agent printed. */
  output: string;
}
