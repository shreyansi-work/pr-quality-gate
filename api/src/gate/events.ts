import type { PrismaService } from '../prisma.service.js';

export type EventType =
  | 'FOUND' | 'CREATED' | 'ACCEPTED' | 'HELD' | 'REJECTED' | 'UNREJECTED'
  | 'FIXED' | 'REOPENED' | 'EDITED'
  | 'AUTO_CLOSED' | 'NEEDS_LOOK' | 'AUTO_REOPENED' | 'PR_CLOSED' | 'PR_REOPENED';

/** Add one line to a ticket's history. */
export async function logEvent(
  prisma: Pick<PrismaService, 'ticketEvent'>,
  findingId: number,
  type: EventType,
  message: string,
  actor: 'system' | 'you',
  commitSha?: string,
) {
  await prisma.ticketEvent.create({ data: { findingId, type, message, actor, commitSha: commitSha ?? null } });
}

export const shortSha = (sha?: string) => (sha ? sha.slice(0, 7) : '');
