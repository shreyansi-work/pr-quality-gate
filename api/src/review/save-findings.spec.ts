import { describe, expect, it } from 'vitest';
import { ReviewService } from './review.service.js';
import { fingerprint } from './fingerprint.js';

const FILE = 'backend/src/auth/auth.service.ts';
const OLD_QUOTE = 'passwordResetExpires: new Date(Date.now() + ttlMinutes * 60),';
const OLD_FP = fingerprint('x', FILE, undefined, OLD_QUOTE);

/** A fake database with one earlier finding, enough for saveFindings. */
function setup() {
  const upserts: string[] = [];
  const prisma = {
    finding: {
      findMany: async () => [{ id: 1, fingerprint: OLD_FP, file: FILE, quote: OLD_QUOTE, source: 'AI' }],
      upsert: async (args: { where: { pullRequestId_fingerprint: { fingerprint: string } } }) => {
        upserts.push(args.where.pullRequestId_fingerprint.fingerprint);
        return { id: 99 };
      },
    },
    ticketEvent: { create: async () => ({}) },
  };
  const service = new ReviewService({} as never, prisma as never, { get: () => undefined } as never);
  return { service, upserts };
}

// What the model reports after the fix: a shorter piece of the same line.
const reported = (quote: string) =>
  [{
    source: 'AI', category: 'logic_error', severity: 'MEDIUM', file: FILE, title: 'Unit of the reset token',
    quote, message: 'm', fingerprint: fingerprint('x', FILE, undefined, quote),
  }] as never;

const FIXED_PATCH = '@@ -210,7 +210,7 @@\n-          passwordResetExpires: new Date(Date.now() + ttlMinutes * 60),\n+          passwordResetExpires: new Date(Date.now() + ttlMinutes * 60 * 1000),';
const SAME_PATCH = '@@ -210,7 +210,7 @@\n           passwordResetExpires: new Date(Date.now() + ttlMinutes * 60),\n+          const other = 1;';

describe('saveFindings: is a similar quote the old finding?', () => {
  it('does NOT link it when the old line was edited (the fixed ticket must not stay open)', async () => {
    const { service, upserts } = setup();
    const saved = await service.saveFindings(1, 1, reported('Date.now() + ttlMinutes * 60'), 'abc1234', new Map([[FILE, FIXED_PATCH]]));
    expect(saved.seen.has(OLD_FP)).toBe(false);
    expect(upserts).toHaveLength(1);
    expect(upserts[0] === OLD_FP).toBe(false);
  });
  it('still links it when the old line is unchanged (the model only quoted a part of it)', async () => {
    const { service } = setup();
    const saved = await service.saveFindings(1, 1, reported('Date.now() + ttlMinutes * 60'), 'abc1234', new Map([[FILE, SAME_PATCH]]));
    expect(saved.seen.has(OLD_FP)).toBe(true);
  });
  it('links it as before when no diff is given', async () => {
    const { service } = setup();
    const saved = await service.saveFindings(1, 1, reported('Date.now() + ttlMinutes * 60'), 'abc1234');
    expect(saved.seen.has(OLD_FP)).toBe(true);
  });
});
