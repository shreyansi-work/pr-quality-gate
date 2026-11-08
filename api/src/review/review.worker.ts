import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import { filterFiles, isCodeFile } from '../github/diff-filter.js';
import { GithubService, TooManyFilesError } from '../github/github.service.js';
import { LlmProvider } from '../llm/llm.provider.js';
import { GateService } from '../gate/gate.service.js';
import { RecheckService } from '../gate/recheck.service.js';
import { PrismaService } from '../prisma.service.js';
import type { Redis } from 'ioredis';
import { REVIEW_QUEUE, createRedis, type ReviewJobData } from './review-queue.service.js';
import { needsContext, patchFromContent } from './context.js';
import { ReviewService } from './review.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class ReviewWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ReviewWorker.name);
  private worker?: Worker<ReviewJobData>;
  private redis?: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly review: ReviewService,
    private readonly llm: LlmProvider,
    private readonly recheck: RecheckService,
    private readonly gate: GateService,
  ) {}

  onModuleInit() {
    this.redis = createRedis(this.config); // the worker gets its own connection
    this.worker = new Worker<ReviewJobData>(REVIEW_QUEUE, (job) => this.process(job), {
      connection: this.redis,
      concurrency: 1, // one review at a time: the local model is the bottleneck
    });
    this.worker.on('failed', (job, err) =>
      this.log.error(`job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`),
    );
    this.worker.on('error', (err) => this.log.error(`worker error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.redis?.quit();
  }

  /** A number from the environment, or the default when it is missing or not a number. */
  private number(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private async isStale(pullRequestId: number, headSha: string): Promise<boolean> {
    const pr = await this.prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      select: { headSha: true },
    });
    return !pr || pr.headSha !== headSha;
  }

  async process(job: Job<ReviewJobData>) {
    const run = await this.prisma.prRun.findUnique({
      where: { id: job.data.runId },
      include: { pullRequest: { include: { repo: true } } },
    });
    if (!run) return { skipped: 'run not found' };
    if (run.status === 'DONE' || run.status === 'SKIPPED') return { skipped: run.status };

    const pr = run.pullRequest;
    const stale = () => this.isStale(pr.id, run.headSha);

    if (pr.state !== 'open') {
      // Closed or merged while it waited in the queue: nobody needs this review.
      await this.prisma.prRun.update({
        where: { id: run.id },
        data: { status: 'SKIPPED', error: 'The pull request is closed', finishedAt: new Date() },
      });
      return { skipped: 'closed' };
    }

    if (await stale()) {
      await this.prisma.prRun.update({
        where: { id: run.id },
        data: { status: 'SKIPPED', error: 'A newer push exists', finishedAt: new Date() },
      });
      return { skipped: 'stale' };
    }

    if (!pr.repo.installationId) {
      await this.prisma.prRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: 'No GitHub App installation id for this repo (webhook did not come from the App)',
          finishedAt: new Date(),
        },
      });
      return { failed: 'no installation' }; // not an exception: retrying cannot fix this
    }

    await this.prisma.prRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date(), error: null },
    });
    await this.gate.syncStatus(pr.id); // GitHub shows "Review in progress"

    try {
      const [owner, name] = pr.repo.fullName.split('/');
      const installationId = pr.repo.installationId;

      const listed = await this.github.listPullRequestFiles(installationId, owner, name, pr.number);
      // GitHub leaves out the diff of a very large change. For a code file that would mean "not reviewed",
      // so we read the file ourselves and review all of it.
      const files = await Promise.all(listed.map(async (f) => {
        if (f.patch || f.status === 'removed' || !isCodeFile(f.filename)) return f;
        const text = await this.github.getFileContent(installationId, owner, name, f.filename, run.headSha);
        return text ? { ...f, patch: patchFromContent(text) } : f;
      }));
      const checks = await this.github.listCheckRuns(installationId, owner, name, run.headSha);
      const { reviewable, skipped } = filterFiles(
        files,
        this.number('REVIEW_MAX_FILE_CHARS', 36_000),
        this.number('REVIEW_MAX_TOTAL_CHARS', 80_000),
      );

      // The full text of each changed file, so the model understands the code around a change.
      // Switch off with REVIEW_CONTEXT_CHARS=0. A file that cannot be read is simply reviewed without it.
      const contexts = new Map<string, string>();
      if (this.number('REVIEW_CONTEXT_CHARS', 16_000) > 0) {
        for (const f of reviewable) {
          if (!needsContext(f.status)) continue;
          const text = await this.github.getFileContent(installationId, owner, name, f.filename, run.headSha);
          if (text) contexts.set(f.filename, text);
        }
      }

      const result = await this.review.reviewFiles(reviewable, files, stale, contexts);

      if (result.stats.aborted) {
        await this.prisma.prRun.update({
          where: { id: run.id },
          data: { status: 'SKIPPED', error: 'A newer push arrived during the review', finishedAt: new Date() },
        });
        return { skipped: 'stale during run' };
      }

      // A push can arrive between the last file and now. Do not save results for old code.
      if (await stale()) {
        await this.prisma.prRun.update({
          where: { id: run.id },
          data: { status: 'SKIPPED', error: 'A newer push arrived while the review finished', finishedAt: new Date() },
        });
        return { skipped: 'stale before save' };
      }

      const saved = await this.review.saveFindings(
        run.id,
        pr.id,
        result.findings,
        run.headSha,
        new Map(files.map((f) => [f.filename, f.patch])),
      );
      // Re-check every open ticket of this PR against the new code; fixed ones close by themselves.
      await this.recheck.run(
        pr.id,
        saved.seen,
        files,
        reviewable,
        run.headSha,
      );
      await this.prisma.prRun.update({
        where: { id: run.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          model: this.llm.modelName,
          changedFiles: toJson(files.map((f) => f.filename)),
          skippedFiles: toJson(skipped),
          ciSummary: toJson(checks),
        },
      });
      await this.gate.syncStatus(pr.id); // success / failure / pending, depending on the tickets
      return { done: true, stats: result.stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.prRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() },
      });
      await this.gate.syncStatus(pr.id);
      if (err instanceof TooManyFilesError) return { failed: 'too many files' }; // retrying cannot fix this
      throw err; // let BullMQ retry with backoff
    }
  }
}
