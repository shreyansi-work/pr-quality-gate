import type { Finding } from '../generated/prisma/client.js';

/** Which board column a ticket belongs to. */
export type TicketColumn = 'ACCEPTED' | 'HELD' | 'NEEDS_LOOK' | 'FIXED';

export function columnOf(f: Pick<Finding, 'status' | 'ticketState'>): TicketColumn | null {
  // Fixed before anyone triaged it: it shows with the other fixed items.
  if (f.status === 'GONE') return 'FIXED';
  if (f.status !== 'ACCEPTED' && f.status !== 'HELD') return null;
  if (f.ticketState === 'FIXED_AUTO' || f.ticketState === 'FIXED_MANUAL' || f.ticketState === 'CLOSED_PR') return 'FIXED';
  if (f.ticketState === 'NEEDS_LOOK') return 'NEEDS_LOOK';
  return f.status === 'ACCEPTED' ? 'ACCEPTED' : 'HELD';
}

/** Explicit shape sent to the UI. (Returning raw rows would break on BigInt and leak fields.) */
export function findingDto(f: Finding) {
  return {
    id: f.id,
    pullRequestId: f.pullRequestId,
    fingerprint: f.fingerprint,
    source: f.source,
    category: f.category,
    severity: f.severity,
    file: f.file,
    functionName: f.functionName,
    quote: f.quote,
    message: f.message,
    title: f.title,
    description: f.description,
    suggestedFix: f.suggestedFix,
    confidence: f.confidence,
    status: f.status,
    ticketState: f.ticketState,
    column: columnOf(f),
    rejectReason: f.rejectReason,
    closeReason: f.closeReason,
    closedAt: f.closedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}
