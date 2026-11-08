import { Injectable } from '@nestjs/common';
import { GateService } from './gate/gate.service.js';
import { PrismaService } from './prisma.service.js';
import { ReviewQueueService } from './review/review-queue.service.js';

export interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  pull_request: {
    number: number;
    title: string;
    state: string;
    merged?: boolean;
    user: { login: string };
    head: { ref: string; sha: string };
  };
  repository: { id: number; full_name: string };
}

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ReviewQueueService,
    private readonly gate: GateService,
  ) {}

  async handlePullRequest(event: PullRequestEvent) {
    const { repository, pull_request: pr } = event;
    const owner = repository.full_name.split('/')[0];
    const installationId = event.installation?.id;

    const user = await this.prisma.user.upsert({
      where: { githubLogin: owner },
      update: {},
      create: { githubLogin: owner },
    });
    const repo = await this.prisma.repo.upsert({
      where: { githubRepoId: repository.id },
      update: { fullName: repository.full_name, ...(installationId ? { installationId } : {}) },
      create: {
        githubRepoId: repository.id,
        fullName: repository.full_name,
        userId: user.id,
        installationId,
      },
    });
    const data = {
      title: pr.title,
      author: pr.user.login,
      headBranch: pr.head.ref,
      headSha: pr.head.sha,
      state: pr.state,
    };
    const saved = await this.prisma.pullRequest.upsert({
      where: { repoId_number: { repoId: repo.id, number: pr.number } },
      update: data,
      create: { repoId: repo.id, number: pr.number, ...data },
    });

    // Merged or closed: its tickets are done. Reopened: bring them back before the new review runs.
    if (event.action === 'closed') await this.gate.onPullRequestClosed(saved.id, pr.merged === true);
    if (event.action === 'reopened') await this.gate.onPullRequestReopened(saved.id);

    // A new commit (or a newly opened PR) means: queue a review for exactly this commit.
    if (REVIEW_ACTIONS.has(event.action)) {
      await this.queue.enqueue(saved.id, saved.headSha);
      void this.gate.syncStatus(saved.id); // "Review in progress" appears on the PR; do not make GitHub wait for it (it never throws)
    }
    return saved;
  }
}
