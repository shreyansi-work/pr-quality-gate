import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { filterFiles, parseUnifiedDiff } from '../github/diff-filter.js';
import { GateService } from '../gate/gate.service.js';
import { IdPipe } from '../gate/id.pipe.js';
import { RecheckService } from '../gate/recheck.service.js';
import { PrismaService } from '../prisma.service.js';
import { fingerprint } from '../review/fingerprint.js';
import { ReviewService } from '../review/review.service.js';

// The dev routes are OFF unless ENABLE_DEV_ROUTES=true is set. They used to be on whenever NODE_ENV was not
// "production", so a server that forgot NODE_ENV let anyone call /dev/review and spend your AI credits.
const guardDev = () => {
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_ROUTES !== 'true') throw new NotFoundException();
};

const DEMO_SHA = 'demo000000000000000000000000000000000001';
const DEMO_FILE = 'src/auth/auth.service.ts';

/** Findings that match the sample diffs in docs/WALKTHROUGH.md exactly. */
const DEMO_FINDINGS = [
  { category: 'null_handling', severity: 'HIGH' as const, fn: 'login', quote: 'const name = user.name.trim();', message: '`user` can be null when the email is unknown, so `user.name` throws.', fix: 'Return an error when `user` is null before reading its fields.' },
  { category: 'hardcoded_secret', severity: 'HIGH' as const, fn: '', quote: "const secret = 'dev-secret-123';", message: 'A signing secret is written in the source code.', fix: 'Read it from an environment variable.' },
  { category: 'async_await', severity: 'MEDIUM' as const, fn: 'login', quote: 'this.audit.log(user.id);', message: 'The audit call returns a promise that is not awaited, so failures are lost.', fix: 'Add `await`.' },
];

/**
 * Development-only helpers. Every route returns 404 when NODE_ENV=production.
 * They let you test everything without a GitHub App.
 */
@Controller('dev')
export class DevController {
  constructor(
    private readonly review: ReviewService,
    private readonly prisma: PrismaService,
    private readonly recheck: RecheckService,
    private readonly gate: GateService,
  ) {}

  /** Review a plain `git diff` and see exactly what the pipeline kept and dropped. */
  @Post('review')
  @HttpCode(200)
  async reviewDiff(@Body() diff: string) {
    guardDev();
    if (typeof diff !== 'string' || !diff.trim()) {
      throw new BadRequestException('Send a git diff as the request body with Content-Type: text/plain');
    }
    const files = parseUnifiedDiff(diff);
    const { reviewable, skipped } = filterFiles(files);
    const result = await this.review.reviewFiles(reviewable, files);
    return { filesInDiff: files.length, skipped, ...result };
  }

  /** Create (or reset) a demo pull request with 3 AI findings and the "no tests" rule finding, all untriaged. */
  @Post('seed')
  @HttpCode(200)
  async seed() {
    guardDev();
    const user = await this.prisma.user.upsert({ where: { githubLogin: 'demo' }, update: {}, create: { githubLogin: 'demo' } });
    const repo = await this.prisma.repo.upsert({
      where: { githubRepoId: 1n },
      update: {},
      create: { githubRepoId: 1n, fullName: 'demo/auth-app', userId: user.id },
    });
    const pr = await this.prisma.pullRequest.upsert({
      where: { repoId_number: { repoId: repo.id, number: 1 } },
      update: { headSha: DEMO_SHA, state: 'open' },
      create: { repoId: repo.id, number: 1, title: 'Add login', author: 'demo', headBranch: 'feat/login', headSha: DEMO_SHA, state: 'open' },
    });
    const run = await this.prisma.prRun.upsert({
      where: { pullRequestId_headSha: { pullRequestId: pr.id, headSha: DEMO_SHA } },
      update: { status: 'DONE' },
      create: {
        pullRequestId: pr.id,
        headSha: DEMO_SHA,
        status: 'DONE',
        model: 'demo',
        finishedAt: new Date(),
        changedFiles: [DEMO_FILE],
        skippedFiles: [{ file: 'package-lock.json', reason: 'Lockfile written by a package manager, no logic', coveredBy: 'the dependency audit' }],
        ciSummary: [{ name: 'build', status: 'completed', conclusion: 'success' }],
      },
    });

    await this.prisma.ticketEvent.deleteMany({ where: { finding: { pullRequestId: pr.id } } });

    const rows = [
      ...DEMO_FINDINGS.map((d) => ({
        source: 'AI' as const, category: d.category, severity: d.severity, file: DEMO_FILE, functionName: d.fn || undefined,
        quote: d.quote, message: d.message, suggestedFix: d.fix, confidence: 'high',
      })),
      (() => {
        const quote = `source changed without tests: ${DEMO_FILE}`;
        return { source: 'RULE' as const, category: 'missing_test', severity: 'LOW' as const, file: DEMO_FILE, functionName: undefined, quote, message: 'Source files changed but no test file changed in this PR.', suggestedFix: undefined, confidence: undefined };
      })(),
    ];
    for (const r of rows) {
      const fp = fingerprint(r.category, r.file, r.functionName, r.quote);
      const reset = { status: 'NEW' as const, ticketState: null, rejectReason: null, closedAt: null, closeReason: null, triagedAt: null, lastSeenRunId: run.id };
      await this.prisma.finding.upsert({
        where: { pullRequestId_fingerprint: { pullRequestId: pr.id, fingerprint: fp } },
        update: reset,
        create: { pullRequestId: pr.id, firstRunId: run.id, fingerprint: fp, ...r, ...reset },
      });
    }
    return { pullRequestId: pr.id, open: `/#/pr/${pr.id}`, findings: rows.length };
  }

  /**
   * Simulate a new push: send the new `git diff` as plain text and every open ticket of the PR
   * is re-checked against it. The full review is NOT re-run (only the rules, and the AI is asked
   * only about lines that changed inside a function), so findings are never "seen again" by the AI here.
   */
  @Post('recheck/:id')
  @HttpCode(200)
  async recheckDiff(@Param('id', IdPipe) id: number, @Body() diff: string) {
    guardDev();
    if (typeof diff !== 'string' || !diff.trim()) throw new BadRequestException('Send the new git diff as text/plain');
    const pr = await this.prisma.pullRequest.findUnique({ where: { id } });
    if (!pr) throw new NotFoundException(`Pull request ${id} not found`);
    const files = parseUnifiedDiff(diff);
    const { reviewable } = filterFiles(files);
    const seen = new Set(this.review.ruleFindings(files).map((f) => f.fingerprint));
    const result = await this.recheck.run(id, seen, files, reviewable);
    await this.gate.syncStatus(id);
    const readiness = await this.gate.readiness(id);
    return { ...result, readiness: readiness.state, counts: readiness.counts };
  }

  /**
   * Run once after updating: findings are now identified by file + code only. This recomputes the stored
   * identities so tickets you already decided on keep matching. Rows that would clash are left alone.
   */
  @Post('refingerprint')
  @HttpCode(200)
  async refingerprint() {
    guardDev();
    const rows = await this.prisma.finding.findMany({ where: { source: { in: ['AI', 'RULE'] } }, orderBy: { id: 'asc' } });
    let updated = 0;
    let skipped = 0;
    for (const r of rows) {
      const rule = r.source === 'RULE';
      const quote = rule ? 'source changed without tests' : r.quote;
      const fp = rule ? fingerprint('missing_test', 'pull-request', undefined, quote) : fingerprint(r.category, r.file, r.functionName ?? undefined, quote);
      if (fp === r.fingerprint && quote === r.quote) continue;
      try {
        await this.prisma.finding.update({ where: { id: r.id }, data: { fingerprint: fp, quote } });
        updated++;
      } catch {
        skipped++; // another finding of the same pull request already has this identity
      }
    }
    return { updated, skipped };
  }
}
