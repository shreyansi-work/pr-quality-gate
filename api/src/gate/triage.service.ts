import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { findingDto } from './dto.js';
import { logEvent } from './events.js';
import { GateService } from './gate.service.js';

export type Decision = 'ACCEPT' | 'HOLD' | 'REJECT' | 'UNREJECT';

@Injectable()
export class TriageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: GateService,
  ) {}

  private async load(id: number) {
    const f = await this.prisma.finding.findUnique({ where: { id } });
    if (!f) throw new NotFoundException(`Finding ${id} not found`);
    if (f.status === 'GONE') {
      throw new ConflictException('This finding is no longer in the code, nothing to triage');
    }
    return f;
  }

  /** Accept or Hold create a ticket. Reject closes it, with a reason. */
  async triage(id: number, decision: Decision, reason?: string) {
    const f = await this.load(id);
    const closed = f.ticketState === 'FIXED_AUTO' || f.ticketState === 'FIXED_MANUAL' || f.ticketState === 'CLOSED_PR';
    // Pressing the same button twice (a double click) changes nothing and adds no history line.
    if (decision === 'REJECT' && f.status === 'REJECTED') return findingDto(f);
    if (decision === 'ACCEPT' && f.status === 'ACCEPTED' && f.ticketState === 'OPEN') return findingDto(f);
    if (decision === 'HOLD' && f.status === 'HELD' && f.ticketState === 'OPEN') return findingDto(f);
    if (decision === 'UNREJECT' && f.status !== 'REJECTED') throw new ConflictException('Only a rejected finding can be un-rejected');
    if (decision !== 'UNREJECT' && f.status === 'REJECTED') throw new ConflictException('This finding is rejected. Un-reject it first');
    if (decision !== 'UNREJECT' && closed) throw new ConflictException('This ticket is closed. Reopen it first');
    const now = new Date();
    const data: Prisma.FindingUpdateInput =
      decision === 'UNREJECT'
        ? { status: 'NEW' as const, ticketState: null, rejectReason: null, closedAt: null, closeReason: null }
        : decision === 'REJECT'
        ? { status: 'REJECTED' as const, ticketState: null, rejectReason: reason ?? null, closedAt: null, closeReason: null }
        : {
            status: decision === 'ACCEPT' ? ('ACCEPTED' as const) : ('HELD' as const),
            ticketState: f.ticketState === 'NEEDS_LOOK' ? ('NEEDS_LOOK' as const) : ('OPEN' as const),
            rejectReason: null,
            closedAt: null,
            closeReason: f.ticketState === 'NEEDS_LOOK' ? f.closeReason : null,
          };
    const saved = await this.prisma.finding.update({ where: { id }, data: { ...data, triagedAt: now } });
    const what = {
      ACCEPT: ['ACCEPTED', 'You accepted it (blocks Ready to merge until fixed)'],
      HOLD: ['HELD', 'You put it on hold (does not block)'],
      REJECT: ['REJECTED', `You rejected it${reason ? `: ${reason}` : ''}`],
      UNREJECT: ['UNREJECTED', 'You un-rejected it, it is waiting for triage again'],
    } as const;
    await logEvent(this.prisma, id, what[decision][0], what[decision][1], 'you');
    await this.gate.syncStatus(saved.pullRequestId);
    return findingDto(saved);
  }

  /** You checked it yourself and it is fixed. */
  async confirmFixed(id: number) {
    const f = await this.load(id);
    if (!f.ticketState) throw new ConflictException('Only tickets can be marked fixed. Accept or hold it first');
    const saved = await this.prisma.finding.update({
      where: { id },
      data: { ticketState: 'FIXED_MANUAL', closedAt: new Date(), closeReason: 'Confirmed fixed by you' },
    });
    await logEvent(this.prisma, id, 'FIXED', 'You confirmed it is fixed', 'you');
    await this.gate.syncStatus(saved.pullRequestId);
    return findingDto(saved);
  }

  /** A fixed ticket (or a "Needs a look" one) is still a problem. */
  async reopen(id: number) {
    const f = await this.load(id);
    if (!f.ticketState) throw new ConflictException('Only tickets can be reopened');
    const saved = await this.prisma.finding.update({
      where: { id },
      data: { ticketState: 'OPEN', closedAt: null, closeReason: null },
    });
    await logEvent(this.prisma, id, 'REOPENED', 'You reopened it', 'you');
    await this.gate.syncStatus(saved.pullRequestId);
    return findingDto(saved);
  }

  /** Change the words (and severity) of a ticket. The fingerprint never changes, so re-checks still match it. */
  async edit(id: number, patch: { title?: string; description?: string; severity?: 'HIGH' | 'MEDIUM' | 'LOW' }) {
    await this.load(id);
    const saved = await this.prisma.finding.update({ where: { id }, data: patch });
    const changed = [patch.title !== undefined && 'title', patch.description !== undefined && 'description', patch.severity !== undefined && 'priority'].filter(Boolean);
    await logEvent(this.prisma, id, 'EDITED', `You edited the ${changed.join(', ')}`, 'you');
    return findingDto(saved);
  }

  /** A ticket you write yourself (a task the review did not find). It is accepted and open from the start. */
  async create(input: {
    pullRequestId: number;
    title: string;
    description?: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    status: 'ACCEPTED' | 'HELD';
  }) {
    const pr = await this.prisma.pullRequest.findUnique({ where: { id: input.pullRequestId } });
    if (!pr) throw new NotFoundException(`Pull request ${input.pullRequestId} not found`);
    const saved = await this.prisma.finding.create({
      data: {
        pullRequestId: pr.id,
        fingerprint: `manual-${randomUUID()}`,
        source: 'MANUAL',
        category: 'manual',
        severity: input.severity,
        file: '',
        quote: '',
        message: input.title,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        ticketState: 'OPEN',
        triagedAt: new Date(),
      },
    });
    await logEvent(this.prisma, saved.id, 'CREATED', 'You created this ticket', 'you');
    await this.gate.syncStatus(pr.id);
    return findingDto(saved);
  }

  /**
   * Delete a ticket. One you wrote by hand is removed for good. One the review found is marked
   * rejected instead, because deleting the row would make the same finding come back on the next push.
   */
  async remove(id: number) {
    const f = await this.prisma.finding.findUnique({ where: { id } });
    if (!f) throw new NotFoundException(`Finding ${id} not found`);
    if (f.source === 'MANUAL') {
      await this.prisma.finding.delete({ where: { id } });
    } else {
      await this.prisma.finding.update({
        where: { id },
        data: { status: 'REJECTED', ticketState: null, rejectReason: 'Deleted by you', closedAt: null, closeReason: null },
      });
      await logEvent(this.prisma, id, 'REJECTED', 'You deleted the ticket (kept as rejected so it does not come back)', 'you');
    }
    await this.gate.syncStatus(f.pullRequestId);
    return { deleted: true, kind: f.source === 'MANUAL' ? 'removed' : 'rejected' };
  }
}
