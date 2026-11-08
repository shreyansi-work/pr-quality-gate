import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubService } from '../github/github.service.js';
import { PrismaService } from '../prisma.service.js';
import { logEvent } from './events.js';
import { pickRun, readinessOf, type Readiness, type ReadinessCounts } from './readiness.js';

export const STATUS_CONTEXT = 'PR Quality Gate';

/** Turn a readiness into the GitHub commit status that shows next to the PR's checks. */
export function statusFor(
  state: Readiness,
  c: ReadinessCounts,
): { state: 'pending' | 'success' | 'failure' | 'error'; description: string } {
  switch (state) {
    case 'READY':
      return { state: 'success', description: 'Ready to merge: every accepted ticket is fixed' };
    case 'NOT_READY':
      return { state: 'failure', description: `${c.acceptedOpen} accepted ticket(s) still open` };
    case 'NEEDS_TRIAGE':
      return { state: 'pending', description: `${c.toTriage} finding(s) waiting for triage` };
    case 'FAILED':
      return { state: 'error', description: 'The review failed. Open the report for details' };
    default:
      return { state: 'pending', description: 'Review in progress' };
  }
}

@Injectable()
export class GateService {
  private readonly log = new Logger(GateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly config: ConfigService,
  ) {}

  /** Newest run + all findings -> readiness. */
  async readiness(pullRequestId: number) {
    const pr = await this.prisma.pullRequest.findUniqueOrThrow({
      where: { id: pullRequestId },
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 10 },
        findings: { select: { status: true, ticketState: true } },
      },
    });
    return { pr, ...readinessOf(pr.headSha, pickRun(pr.headSha, pr.runs), pr.findings) };
  }

  /**
   * Post the current readiness to GitHub as a commit status on the PR's latest commit.
   * Never throws: a failed status call must not break triage or the review run.
   */
  async syncStatus(pullRequestId: number): Promise<void> {
    try {
      const { pr, state, counts } = await this.readiness(pullRequestId);
      if (pr.state !== 'open') return;
      const repo = await this.prisma.repo.findUniqueOrThrow({ where: { id: pr.repoId } });
      if (!repo.installationId) return; // not connected to a GitHub App (local testing)
      const [owner, name] = repo.fullName.split('/');
      const publicUrl = this.config.get<string>('PUBLIC_URL');
      const { state: ghState, description } = statusFor(state, counts);
      await this.github.setCommitStatus(repo.installationId, owner, name, pr.headSha, {
        state: ghState,
        description,
        context: STATUS_CONTEXT,
        targetUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/#/pr/${pr.id}` : undefined,
      });
    } catch (err) {
      this.log.warn(`could not post status for PR ${pullRequestId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** The pull request was merged or closed: its open tickets are done, nobody needs to chase them. */
  async onPullRequestClosed(pullRequestId: number, merged: boolean) {
    const reason = merged ? 'The pull request was merged' : 'The pull request was closed without merging';
    const open = await this.prisma.finding.findMany({
      where: { pullRequestId, ticketState: { in: ['OPEN', 'NEEDS_LOOK'] } },
      select: { id: true },
    });
    if (open.length === 0) return 0;
    await this.prisma.finding.updateMany({
      where: { id: { in: open.map((f) => f.id) } },
      data: { ticketState: 'CLOSED_PR', closedAt: new Date(), closeReason: reason },
    });
    for (const f of open) await logEvent(this.prisma, f.id, 'PR_CLOSED', `Closed automatically: ${reason}`, 'system');
    this.log.log(`PR ${pullRequestId}: ${open.length} ticket(s) closed (${reason})`);
    return open.length;
  }

  /** The pull request was reopened: bring back the tickets that were closed only because of the close. */
  async onPullRequestReopened(pullRequestId: number) {
    const closed = await this.prisma.finding.findMany({
      where: { pullRequestId, ticketState: 'CLOSED_PR' },
      select: { id: true },
    });
    if (closed.length === 0) return 0;
    await this.prisma.finding.updateMany({
      where: { id: { in: closed.map((f) => f.id) } },
      data: { ticketState: 'OPEN', closedAt: null, closeReason: null },
    });
    for (const f of closed) await logEvent(this.prisma, f.id, 'PR_REOPENED', 'Reopened automatically: the pull request was reopened', 'system');
    return closed.length;
  }
}
