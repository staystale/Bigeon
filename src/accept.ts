// Bigeon accept: check a reviewed worker branch (result, base, CI), then push it to main.
import { git, mainRef } from './lib.ts';
import { readNote, RemoteError } from './comms.ts';
import type { Config } from './types.ts';

const POLL_MS = 15000;

export function githubRepo(url: string): { owner: string; repo: string } | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

export function summarizeChecks(json: unknown): 'success' | 'failure' | 'pending' | 'none' {
  if (typeof json !== 'object' || json === null) return 'none';
  const runs = (json as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(runs) || runs.length === 0) return 'none';
  const items = runs.map((item) => (typeof item === 'object' && item !== null ? item : {}) as {
    status?: unknown;
    conclusion?: unknown;
  });
  if (items.some((item) => item.status !== 'completed')) return 'pending';
  const fine = ['success', 'skipped', 'neutral'];
  if (items.some((item) => typeof item.conclusion !== 'string' || !fine.includes(item.conclusion))) return 'failure';
  return 'success';
}

async function readChecks(owner: string, repo: string, sha: string): Promise<'success' | 'failure' | 'pending' | 'none'> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`, { headers });
    if (!response.ok) return 'none';
    return summarizeChecks(await response.json());
  } catch {
    return 'none';
  }
}

export async function accept(
  projectDir: string,
  config: Config,
  id: string,
  options: { dryRun?: boolean; timeoutMinutes?: number; log: (line: string) => void },
): Promise<number> {
  const { log } = options;
  const { remote } = config;
  const fetched = git(['fetch', '--quiet', remote], projectDir);
  if (!fetched.ok) {
    log(`cannot reach ${remote}: ${fetched.err || fetched.out}`);
    return 3;
  }

  const branch = `${remote}/worker/${id}`;
  if (!git(['rev-parse', '--verify', '--quiet', `refs/remotes/${branch}`], projectDir).ok) {
    log(`no branch worker/${id}`);
    return 1;
  }

  let note: string | null;
  try {
    note = readNote(projectDir, config, 'result', id);
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error;
    log(error.message);
    return 3;
  }
  if (note === null || !/Status: PASS/.test(note)) {
    log(`result ${id} is not PASS`);
    return 1;
  }

  const main = mainRef(projectDir, remote);
  if (!main) {
    log(`cannot find the main branch on ${remote}`);
    return 1;
  }
  if (!git(['merge-base', '--is-ancestor', main, branch], projectDir).ok) {
    log(`worker/${id} is behind ${main}: send the task again from the current main`);
    return 1;
  }

  const sha = git(['rev-parse', branch], projectDir).out;
  const short = git(['rev-parse', '--short', branch], projectDir).out;
  log(`worker/${id} is at ${short}`);
  const stat = git(['diff', '--stat', main, branch], projectDir);
  if (stat.out) log(stat.out);

  const url = git(['remote', 'get-url', remote], projectDir).out;
  const repo = githubRepo(url);
  if (!repo) {
    log('not a GitHub remote, skipping the CI check');
  } else {
    const timeoutMinutes = options.timeoutMinutes ?? 15;
    const deadline = Date.now() + timeoutMinutes * 60000;
    let state = await readChecks(repo.owner, repo.repo, sha);
    while (state === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      state = await readChecks(repo.owner, repo.repo, sha);
    }
    if (state === 'failure') {
      log(`CI failed for ${short}`);
      return 1;
    }
    if (state === 'pending') {
      log(`CI is still running for ${short}`);
      return 5;
    }
    if (state === 'none') log('could not read CI results, the main branch rules still apply');
  }

  if (options.dryRun) {
    log(`dry run: would push ${short} to ${main}`);
    return 0;
  }

  const mainName = main.startsWith(`${remote}/`) ? main.slice(remote.length + 1) : main;
  const pushed = git(['push', remote, `${sha}:${mainName}`], projectDir);
  if (!pushed.ok) {
    log(pushed.err || pushed.out);
    return 1;
  }
  log(`accepted ${id}: ${main} is now ${short}`);
  return 0;
}
