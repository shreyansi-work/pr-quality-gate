import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAppAuth } from '@octokit/auth-app';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckRunSummary, DiffFile } from './diff.types.js';

/** Thrown when a pull request has more changed files than we can list. Retrying cannot fix it. */
export class TooManyFilesError extends Error {
  constructor() {
    super('This pull request changes more than 1000 files. The review cannot cover all of them, so it was not run.');
    this.name = 'TooManyFilesError';
  }
}

const FILE_PAGES = 10;
const FILES_PER_PAGE = 100;

@Injectable()
export class GithubService {
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  /** A short-lived token that only works for one installation of our GitHub App. */
  private async installationToken(installationId: number): Promise<string> {
    // A token lives for an hour. Reuse it until 5 minutes before it ends instead of asking for a new one on every call.
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const appId = this.config.getOrThrow<string>('GITHUB_APP_ID');
    const keyPath = this.config.getOrThrow<string>('GITHUB_APP_PRIVATE_KEY_PATH');
    const auth = createAppAuth({
      appId,
      privateKey: readFileSync(resolve(keyPath), 'utf8'),
      installationId,
    });
    const { token, expiresAt } = await auth({ type: 'installation' });
    this.tokens.set(installationId, { token, expiresAt: expiresAt ? new Date(expiresAt).getTime() : Date.now() + 30 * 60_000 });
    return token;
  }

  private async get<T>(token: string, path: string): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-quality-gate',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private async post(token: string, path: string, body: unknown): Promise<void> {
    const res = await fetch(`https://api.github.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-quality-gate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} for POST ${path}: ${await res.text()}`);
    }
  }

  /**
   * Put a status (pending / success / failure / error) on a commit. Branch protection can
   * require the context "PR Quality Gate", so the merge button waits for our verdict.
   * Needs the App permission "Commit statuses: Read and write".
   */
  async setCommitStatus(
    installationId: number,
    owner: string,
    repo: string,
    sha: string,
    status: { state: 'pending' | 'success' | 'failure' | 'error'; description: string; context: string; targetUrl?: string },
  ): Promise<void> {
    const token = await this.installationToken(installationId);
    await this.post(token, `/repos/${owner}/${repo}/statuses/${sha}`, {
      state: status.state,
      description: status.description.slice(0, 140), // GitHub's limit
      context: status.context,
      ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
    });
  }

  async listPullRequestFiles(
    installationId: number,
    owner: string,
    repo: string,
    number: number,
  ): Promise<DiffFile[]> {
    const token = await this.installationToken(installationId);
    const all: DiffFile[] = [];
    for (let page = 1; page <= FILE_PAGES; page++) {
      const batch = await this.get<DiffFile[]>(
        token,
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < FILES_PER_PAGE) return all;
    }
    // The last page was full too: there may be more files. Cutting the list here would make the
    // re-check think files that were cut had left the PR, and close their tickets as fixed.
    throw new TooManyFilesError();
  }

  /**
   * The text of one file at one commit, or null when it cannot be read (too big, binary, deleted).
   * It is only context for the review, so a failure here must never fail the review.
   */
  async getFileContent(installationId: number, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const token = await this.installationToken(installationId);
      const safePath = path.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${safePath}?ref=${encodeURIComponent(ref)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw+json', // the file text itself, not JSON
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pr-quality-gate',
        },
      });
      if (!res.ok) return null;
      const text = await res.text();
      return text.includes('\u0000') ? null : text; // a binary file
    } catch {
      return null;
    }
  }

  async listCheckRuns(
    installationId: number,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CheckRunSummary[]> {
    const token = await this.installationToken(installationId);
    const data = await this.get<{ check_runs: CheckRunSummary[] }>(
      token,
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return data.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    }));
  }
}
