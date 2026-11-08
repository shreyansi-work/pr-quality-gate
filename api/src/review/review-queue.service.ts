import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma.service.js';

export const REVIEW_QUEUE = 'review';

export interface ReviewJobData {
  runId: number;
}

/**
 * In native ESM, BullMQ needs a ready-made Redis client (not host/port options).
 * maxRetriesPerRequest: null is required by BullMQ for its blocking connections.
 */
export const createRedis = (config: ConfigService): Redis =>
  new Redis({
    host: config.get<string>('REDIS_HOST') ?? 'localhost',
    port: Number(config.get<string>('REDIS_PORT') ?? 6379),
    maxRetriesPerRequest: null,
  });

@Injectable()
export class ReviewQueueService implements OnModuleDestroy {
  private readonly queue: Queue<ReviewJobData>;
  private readonly redis: Redis;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.redis = createRedis(config);
    this.queue = new Queue<ReviewJobData>(REVIEW_QUEUE, { connection: this.redis });
  }

  /**
   * One run per (pull request, commit). Sending the same webhook twice finds the same row,
   * and BullMQ ignores a job whose jobId already exists. That is deduplication, twice over.
   */
  async enqueue(pullRequestId: number, headSha: string, opts: { force?: boolean } = {}) {
    let run = await this.prisma.prRun.upsert({
      where: { pullRequestId_headSha: { pullRequestId, headSha } },
      update: {},
      create: { pullRequestId, headSha },
    });

    // A run that failed or was skipped earlier (or one you ask to repeat) starts again. Before, a failed
    // run kept its finished job in the queue, the new job with the same id was ignored, and nothing
    // happened until a new commit was pushed.
    if (run.status === 'FAILED' || run.status === 'SKIPPED' || (opts.force && run.status !== 'RUNNING')) {
      const old = await this.queue.getJob(`run-${run.id}`);
      if (old) {
        try {
          await old.remove();
        } catch {
          /* the job is locked: it is running right now, leave it */
        }
      }
      run = await this.prisma.prRun.update({
        where: { id: run.id },
        data: { status: 'QUEUED', error: null, startedAt: null, finishedAt: null },
      });
    }

    // A newer push makes older, still-waiting runs of the same PR pointless.
    await this.prisma.prRun.updateMany({
      where: { pullRequestId, status: 'QUEUED', NOT: { id: run.id } },
      data: { status: 'SKIPPED', error: 'Superseded by a newer push' },
    });

    try {
      await this.queue.add(
        'review-pr',
        { runId: run.id },
        {
          jobId: `run-${run.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );
    } catch (err) {
      // Redis is down: without this the run would stay QUEUED for ever and the PR would say "Reviewing" for ever.
      const message = `Could not queue the review: ${err instanceof Error ? err.message : String(err)}`;
      await this.prisma.prRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() } });
    }
    return run;
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.redis.quit();
  }
}
