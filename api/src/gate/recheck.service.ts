import { Injectable, Logger } from '@nestjs/common';
import type { DiffFile } from '../github/diff.types.js';
import { PrismaService } from '../prisma.service.js';
import { ReviewService } from '../review/review.service.js';
import { logEvent, shortSha } from './events.js';
import { judge, needsAsk, planRecheck, type RecheckContext } from './recheck.js';

@Injectable()
export class RecheckService {
  private readonly log = new Logger(RecheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly review: ReviewService,
  ) {}

  /**
   * After a push has been reviewed: look at every finding of this PR that is not rejected
   * and decide if it is still there, fixed (closed automatically) or unsure ("Needs a look").
   */
  async run(
    pullRequestId: number,
    seen: Set<string>,
    changedFiles: DiffFile[],
    reviewedFiles: DiffFile[],
    commitSha?: string,
  ) {
    const ctx: RecheckContext = {
      seen,
      changed: new Map(changedFiles.map((f) => [f.filename, f])),
      reviewed: new Set(reviewedFiles.map((f) => f.filename)),
      answers: new Map(),
    };
    const findings = await this.prisma.finding.findMany({
      where: { pullRequestId, NOT: { status: 'REJECTED' } },
    });

    // Hard case: the flagged line changed but its function is still in the diff.
    // Ask the AI to re-read the new code. If it fails or is unclear, the ticket becomes "Needs a look".
    const reasons = new Map<string, string>();
    let asked = 0;
    for (const f of findings) {
      if (!needsAsk(f, ctx)) continue;
      asked++;
      try {
        const patch = ctx.changed.get(f.file)?.patch ?? '';
        const answer = await this.review.stillPresent(f.file, patch, f.quote, f.message);
        if (answer.present !== null) ctx.answers?.set(f.fingerprint, answer.present ? 'present' : 'gone');
        if (answer.reason) reasons.set(f.fingerprint, answer.reason);
      } catch (err) {
        this.log.warn(`re-check question failed for finding ${f.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let changed = 0;
    for (const f of findings) {
      // One line per open ticket, so "why is it still open?" can be answered from the log.
      if (f.source !== 'MANUAL' && f.status !== 'GONE' && !['FIXED_AUTO', 'FIXED_MANUAL', 'CLOSED_PR'].includes(f.ticketState ?? '')) {
        const v = judge(f, ctx);
        this.log.log(`PR ${pullRequestId} finding ${f.id} "${f.title}" (${f.file}): ${v.verdict} - ${v.reason}`);
      }
      const patch = planRecheck(f, ctx);
      if (!patch) continue;
      const why = reasons.get(f.fingerprint);
      if (why && patch.closeReason) patch.closeReason = `${patch.closeReason}. ${why}`;
      const at = commitSha ? ` (commit ${shortSha(commitSha)})` : '';
      if (patch.closeReason) patch.closeReason = `${patch.closeReason}${at}`;
      await this.prisma.finding.update({ where: { id: f.id }, data: patch });
      changed++;

      // History line, only for real ticket changes (not for untriaged findings that vanished).
      if (patch.ticketState === 'FIXED_AUTO') await logEvent(this.prisma, f.id, 'AUTO_CLOSED', `Closed automatically: ${patch.closeReason}`, 'system', commitSha);
      else if (patch.ticketState === 'NEEDS_LOOK') await logEvent(this.prisma, f.id, 'NEEDS_LOOK', `Needs a look: ${patch.closeReason}`, 'system', commitSha);
      else if (patch.ticketState === 'OPEN') await logEvent(this.prisma, f.id, 'AUTO_REOPENED', `Reopened automatically: ${patch.closeReason ?? 'the re-check found the problem again'}`, 'system', commitSha);
    }
    this.log.log(`PR ${pullRequestId}: re-check changed ${changed} of ${findings.length} findings (${asked} asked the AI)`);
    return { checked: findings.length, changed, askedAi: asked };
  }
}
