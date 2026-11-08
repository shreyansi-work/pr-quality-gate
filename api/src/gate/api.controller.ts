import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Patch,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { CheckRunSummary } from '../github/diff.types.js';
import { PrismaService } from '../prisma.service.js';
import { ReviewQueueService } from '../review/review-queue.service.js';
import { ApiTokenGuard } from './api-token.guard.js';
import { columnOf, findingDto } from './dto.js';
import { GateService } from './gate.service.js';
import { IdPipe } from './id.pipe.js';
import { pickRun, readinessOf } from './readiness.js';
import { TriageService, type Decision } from './triage.service.js';

interface EditBody {
  title?: unknown;
  description?: unknown;
  severity?: unknown;
}

interface CreateBody extends EditBody {
  pullRequestId?: unknown;
  status?: unknown;
}

const cleanTitle = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException('title is required');
  return v.trim().slice(0, 200);
};
const cleanDescription = (v: unknown): string => {
  if (typeof v !== 'string') throw new BadRequestException('description must be text');
  return v.trim().slice(0, 5000);
};
const cleanSeverity = (v: unknown): 'HIGH' | 'MEDIUM' | 'LOW' => {
  const s = (typeof v === 'string' ? v : '').toUpperCase();
  if (s !== 'HIGH' && s !== 'MEDIUM' && s !== 'LOW') throw new BadRequestException('severity must be HIGH, MEDIUM or LOW');
  return s;
};

interface TriageBody {
  decision?: string;
  reason?: string;
}

const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

/** JSON API used by the web UI. Everything under /api needs the token when API_TOKEN is set. */
@Controller('api')
@UseGuards(ApiTokenGuard)
export class ApiController {
  private readonly ciCache = new Map<string, { at: number; data: CheckRunSummary[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly triage: TriageService,
    private readonly github: GithubService,
    private readonly queue: ReviewQueueService,
    private readonly gate: GateService,
  ) {}

  /**
   * The CI checks of the current commit, read from GitHub now. They used to be saved once when the
   * review finished, which is usually BEFORE the CI does, so the page showed "Running" for ever.
   * Cached for 20 seconds. Returns null when GitHub cannot be reached (the saved list is used then).
   */
  private async liveChecks(fullName: string, installationId: number | null, sha: string): Promise<CheckRunSummary[] | null> {
    if (!installationId) return null;
    const key = `${fullName}@${sha}`;
    const hit = this.ciCache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.data;
    try {
      const [owner, name] = fullName.split('/');
      const data = await this.github.listCheckRuns(installationId, owner, name, sha);
      if (this.ciCache.size > 200) this.ciCache.clear();
      this.ciCache.set(key, { at: Date.now(), data });
      return data;
    } catch {
      return null;
    }
  }

  /** PR list: one row per pull request, with its readiness. */
  @Get('pulls')
  async pulls() {
    const prs = await this.prisma.pullRequest.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        repo: { select: { fullName: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 10 },
        findings: { select: { status: true, ticketState: true, severity: true } },
      },
    });
    return prs.map((pr) => {
      const run = pickRun(pr.headSha, pr.runs);
      const { state, counts } = readinessOf(pr.headSha, run, pr.findings);
      return {
        id: pr.id,
        repo: pr.repo.fullName,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        branch: pr.headBranch,
        headSha: pr.headSha,
        prState: pr.state,
        updatedAt: pr.updatedAt,
        readiness: state,
        counts,
        // open findings by severity (not rejected, not fixed before triage), for the list
        sev: {
          HIGH: pr.findings.filter((f) => f.severity === 'HIGH' && f.status !== 'REJECTED' && f.status !== 'GONE').length,
          MEDIUM: pr.findings.filter((f) => f.severity === 'MEDIUM' && f.status !== 'REJECTED' && f.status !== 'GONE').length,
          LOW: pr.findings.filter((f) => f.severity === 'LOW' && f.status !== 'REJECTED' && f.status !== 'GONE').length,
        },
        run: run && { status: run.status, headSha: run.headSha, error: run.error },
      };
    });
  }

  /** One PR with everything the report page needs. */
  @Get('pulls/:id')
  async pull(@Param('id', IdPipe) id: number) {
    const pr = await this.prisma.pullRequest.findUnique({
      where: { id },
      include: {
        repo: { select: { fullName: true, installationId: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 10 },
        findings: { orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!pr) throw new NotFoundException(`Pull request ${id} not found`);
    const run = pickRun(pr.headSha, pr.runs);
    const live = await this.liveChecks(pr.repo.fullName, pr.repo.installationId, pr.headSha);
    const { state, counts } = readinessOf(pr.headSha, run, pr.findings);
    return {
      id: pr.id,
      repo: pr.repo.fullName,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      branch: pr.headBranch,
      headSha: pr.headSha,
      prState: pr.state,
      readiness: state,
      counts,
      run: run && {
        id: run.id,
        status: run.status,
        headSha: run.headSha,
        model: run.model,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        changedFiles: run.changedFiles,
        skippedFiles: run.skippedFiles,
        ciSummary: live ?? run.ciSummary,
      },
      runs: pr.runs.map((r) => ({ id: r.id, headSha: r.headSha, status: r.status, createdAt: r.createdAt })),
      findings: pr.findings.map(findingDto),
      goneCount: pr.findings.filter((f) => f.status === 'GONE').length,
    };
  }

  /** Run the review again for the current commit (after a failure, or to try another AI model). */
  @Post('pulls/:id/rerun')
  @HttpCode(200)
  async rerun(@Param('id', IdPipe) id: number) {
    const pr = await this.prisma.pullRequest.findUnique({ where: { id } });
    if (!pr) throw new NotFoundException(`Pull request ${id} not found`);
    if (pr.state !== 'open') throw new ConflictException('This pull request is closed, there is nothing to review');
    await this.queue.enqueue(pr.id, pr.headSha, { force: true });
    void this.gate.syncStatus(pr.id);
    return { queued: true };
  }

  /** Ticket board: every accepted or held finding, optionally for one PR or one severity. */
  @Get('tickets')
  async tickets(@Query('pullRequestId') prId?: string, @Query('severity') severity?: string) {
    const where: Prisma.FindingWhereInput = { status: { in: ['ACCEPTED', 'HELD', 'GONE'] } }; // GONE = fixed before triage, shown in Done
    if (prId) {
      const n = Number(prId);
      if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw new BadRequestException('pullRequestId must be a number');
      where.pullRequestId = n;
    }
    if (severity) {
      const s = severity.toUpperCase();
      if (!(SEVERITIES as readonly string[]).includes(s)) throw new BadRequestException('severity must be HIGH, MEDIUM or LOW');
      where.severity = s as (typeof SEVERITIES)[number];
    }
    const rows = await this.prisma.finding.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
      include: { pullRequest: { select: { id: true, number: true, title: true, repo: { select: { fullName: true } } } } },
    });
    return rows.map((f) => ({
      ...findingDto(f),
      column: columnOf(f),
      pull: { id: f.pullRequest.id, number: f.pullRequest.number, title: f.pullRequest.title, repo: f.pullRequest.repo.fullName },
    }));
  }

  /** Accept, Hold or Reject one finding. */
  @Post('findings/:id/triage')
  @HttpCode(200)
  decide(@Param('id', IdPipe) id: number, @Body() body: TriageBody) {
    const decision = String(body?.decision ?? '').toUpperCase();
    if (decision !== 'ACCEPT' && decision !== 'HOLD' && decision !== 'REJECT' && decision !== 'UNREJECT') {
      throw new BadRequestException('decision must be ACCEPT, HOLD, REJECT or UNREJECT');
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
    // The page already asks for it. The API must too, or a rejected finding can have no reason on record.
    if (decision === 'REJECT' && !reason) throw new BadRequestException('A reason is required to reject a finding');
    return this.triage.triage(id, decision as Decision, reason || undefined);
  }

  @Post('findings/:id/fixed')
  @HttpCode(200)
  fixed(@Param('id', IdPipe) id: number) {
    return this.triage.confirmFixed(id);
  }

  @Post('findings/:id/reopen')
  @HttpCode(200)
  reopen(@Param('id', IdPipe) id: number) {
    return this.triage.reopen(id);
  }

  /** One ticket with its pull request, for the detail panel. */
  @Get('findings/:id')
  async one(@Param('id', IdPipe) id: number) {
    const f = await this.prisma.finding.findUnique({
      where: { id },
      include: { pullRequest: { select: { id: true, number: true, title: true, repo: { select: { fullName: true } } } } },
    });
    if (!f) throw new NotFoundException(`Finding ${id} not found`);
    const events = await this.prisma.ticketEvent.findMany({ where: { findingId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
    return {
      ...findingDto(f),
      events: events.map((e) => ({ id: e.id, type: e.type, message: e.message, actor: e.actor, commitSha: e.commitSha, createdAt: e.createdAt })),
      pull: { id: f.pullRequest.id, number: f.pullRequest.number, title: f.pullRequest.title, repo: f.pullRequest.repo.fullName },
    };
  }

  /** Create a ticket by hand. */
  @Post('tickets')
  async create(@Body() body: CreateBody) {
    const pullRequestId = Number(body?.pullRequestId);
    if (!Number.isInteger(pullRequestId) || pullRequestId < 1 || pullRequestId > 2_147_483_647) throw new BadRequestException('pullRequestId must be a number');
    const status = (typeof body?.status === 'string' ? body.status : 'ACCEPTED').toUpperCase();
    if (status !== 'ACCEPTED' && status !== 'HELD') throw new BadRequestException('status must be ACCEPTED or HELD');
    return this.triage.create({
      pullRequestId,
      title: cleanTitle(body?.title),
      description: body?.description === undefined ? undefined : cleanDescription(body.description),
      severity: body?.severity === undefined ? 'MEDIUM' : cleanSeverity(body.severity),
      status,
    });
  }

  /** Edit title, description or severity. */
  @Patch('findings/:id')
  edit(@Param('id', IdPipe) id: number, @Body() body: EditBody) {
    const patch: { title?: string; description?: string; severity?: 'HIGH' | 'MEDIUM' | 'LOW' } = {};
    if (body?.title !== undefined) patch.title = cleanTitle(body.title);
    if (body?.description !== undefined) patch.description = cleanDescription(body.description);
    if (body?.severity !== undefined) patch.severity = cleanSeverity(body.severity);
    if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to change');
    return this.triage.edit(id, patch);
  }

  @Delete('findings/:id')
  remove(@Param('id', IdPipe) id: number) {
    return this.triage.remove(id);
  }
}
