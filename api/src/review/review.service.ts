import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DiffFile } from '../github/diff.types.js';
import { LlmProvider } from '../llm/llm.provider.js';
import { PrismaService } from '../prisma.service.js';
import { logEvent, shortSha } from '../gate/events.js';
import { patchForRecheck, splitPatch, trimContext } from './context.js';
import { addedText, fingerprint, normalize, quoteStillInCode, sameCode } from './fingerprint.js';
import { MAX_FINDINGS_PER_FILE, parseProposed, proposedCount, extractJson, type ProposedFinding } from './parse-findings.js';
import {
  RECHECK_SYSTEM,
  REVIEW_SYSTEM,
  VERIFY_SYSTEM,
  buildRecheckUser,
  buildReviewUser,
  buildVerifyUser,
} from './prompts.js';

export interface ReviewedFinding {
  source: 'AI' | 'RULE';
  category: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  functionName?: string;
  title?: string;
  quote: string;
  message: string;
  suggestedFix?: string;
  confidence?: string;
  fingerprint: string;
}

export interface ReviewStats {
  filesReviewed: number;
  /** Model calls for reviewing. More than filesReviewed when a big file was cut into pieces. */
  chunksReviewed: number;
  /** Files that were sent together with their full text as context. */
  filesWithContext: number;
  proposedByModel: number;
  droppedNoEvidence: number;
  droppedByVerify: number;
  /** Findings the model sent beyond the per-file limit. They are counted here, not lost silently. */
  droppedByCap: number;
  kept: number;
  aborted: boolean;
}

/**
 * Optional step-by-step record of one review. Only the evaluation (api/eval) passes a listener.
 * It answers "why was this bug not reported": was the code sent, did the model propose it, and which step dropped it.
 */
export type ReviewTrace =
  | { type: 'piece'; file: string; patch: string }
  | { type: 'proposed'; file: string; category: string; quote: string; message: string }
  | { type: 'dropped'; file: string; quote: string; reason: 'no_evidence' | 'verify' }
  | { type: 'capped'; file: string; count: number };

export interface ReviewResult {
  model: string;
  stats: ReviewStats;
  findings: ReviewedFinding[];
}

const TEST_FILE = /(\.spec\.|\.test\.)|(^|\/)(test|tests|__tests__)\//;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|php|cs|rs|kt|swift)$/;

@Injectable()
export class ReviewService {
  private readonly log = new Logger(ReviewService.name);

  constructor(
    private readonly llm: LlmProvider,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * reviewable: files the AI may read. allChanged: every changed file (rules need the full picture).
   * shouldAbort: lets the caller stop early, for example when a newer push made this run stale.
   * contexts: the full text of a changed file (by file name). The model reads it to understand the
   * code around a change, but it can still only report problems on lines this PR added.
   */
  async reviewFiles(
    reviewable: DiffFile[],
    allChanged: DiffFile[],
    shouldAbort?: () => Promise<boolean>,
    contexts: Map<string, string> = new Map(),
    trace?: (event: ReviewTrace) => void,
  ): Promise<ReviewResult> {
    const verifyEnabled = (this.config.get<string>('REVIEW_VERIFY') ?? 'true') !== 'false';
    const chunkChars = this.limit('REVIEW_CHUNK_CHARS', 12_000);
    const contextChars = this.limit('REVIEW_CONTEXT_CHARS', 16_000);
    const stats: ReviewStats = {
      filesReviewed: 0,
      chunksReviewed: 0,
      filesWithContext: 0,
      proposedByModel: 0,
      droppedNoEvidence: 0,
      droppedByVerify: 0,
      droppedByCap: 0,
      kept: 0,
      aborted: false,
    };
    const findings: ReviewedFinding[] = [];

    for (const file of reviewable) {
      if (shouldAbort && (await shouldAbort())) {
        stats.aborted = true;
        break;
      }
      const patch = file.patch ?? '';
      const context = trimContext(contexts.get(file.filename) ?? '', contextChars);
      if (context) stats.filesWithContext++;
      stats.filesReviewed++;

      // A big diff (or a big new file) is read in pieces instead of being skipped.
      for (const piece of splitPatch(patch, chunkChars)) {
        if (shouldAbort && (await shouldAbort())) {
          stats.aborted = true;
          break;
        }
        stats.chunksReviewed++;
        trace?.({ type: 'piece', file: file.filename, patch: piece });
        const raw = await this.llm.completeJson(REVIEW_SYSTEM, buildReviewUser(file.filename, piece, context || undefined));
        const proposed = parseProposed(raw);
        stats.proposedByModel += proposed.length;
        const cut = Math.max(0, proposedCount(raw) - MAX_FINDINGS_PER_FILE);
        stats.droppedByCap += cut;
        if (cut > 0) trace?.({ type: 'capped', file: file.filename, count: cut });

        for (const p of proposed) {
          trace?.({ type: 'proposed', file: file.filename, category: p.category, quote: p.quote, message: p.message });
          // 1. Evidence check: the quoted code must be on a line this PR ADDED (a "+" line).
          //    Quotes from removed or unchanged lines are not this PR's problem.
          const evidence = this.evidenceQuote(piece, p.quote);
          if (evidence === null) {
            stats.droppedNoEvidence++;
            trace?.({ type: 'dropped', file: file.filename, quote: p.quote, reason: 'no_evidence' });
            continue;
          }
          p.quote = evidence;
          // 2. Second pass: ask the model to double-check its own claim.
          if (verifyEnabled && !(await this.verify(file, piece, p, context || undefined))) {
            stats.droppedByVerify++;
            trace?.({ type: 'dropped', file: file.filename, quote: p.quote, reason: 'verify' });
            continue;
          }
          findings.push({
            source: 'AI',
            category: p.category,
            severity: p.severity,
            file: file.filename,
            functionName: p.functionName,
            title: p.title,
            quote: p.quote,
            message: p.message,
            suggestedFix: p.suggestedFix,
            confidence: p.confidence,
            fingerprint: fingerprint(p.category, file.filename, p.functionName, p.quote),
          });
        }
      }
      if (stats.aborted) break;
    }

    if (!stats.aborted) findings.push(...this.ruleFindings(allChanged));
    stats.kept = findings.length;
    return { model: this.llm.modelName, stats, findings };
  }

  /**
   * The quote as it appears on an added line, or null when it is not there.
   * A leading "+" is removed only when the quote is not found as written (a line of code can start with "+").
   */
  private evidenceQuote(patch: string, quote: string): string | null {
    const added = addedText(patch);
    const found = (q: string) => normalize(q).length >= 6 && added.includes(normalize(q));
    if (found(quote)) return quote;
    const stripped = quote.replace(/^\+\s?/, '');
    return stripped !== quote && found(stripped) ? stripped : null;
  }

  /** A number from the environment, or the default when it is missing or not a number. */
  private limit(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private async verify(file: DiffFile, piece: string, p: ProposedFinding, context?: string): Promise<boolean> {
    const raw = await this.llm.completeJson(
      VERIFY_SYSTEM,
      buildVerifyUser(file.filename, piece, p.quote, p.message, context),
    );
    const answer = extractJson(raw) as { real?: unknown } | null;
    // Only an explicit "false" removes the finding. If the answer is unclear we keep it.
    return answer?.real !== false;
  }

  /**
   * After a push: is an earlier problem still in the new code?
   * present true = still there, false = gone, null = the model's answer was unclear.
   * reason is the model's one-sentence explanation, or '' when it gave none.
   */
  async stillPresent(filename: string, patch: string, quote: string, message: string): Promise<{ present: boolean | null; reason: string }> {
    // The hunk that contains the old quote, without "-" lines. Those lines are the code
    // before the fix, and the model was treating them as the code that exists now.
    const piece = patchForRecheck(patch, quote, this.limit('REVIEW_CHUNK_CHARS', 12_000));
    const raw = await this.llm.completeJson(RECHECK_SYSTEM, buildRecheckUser(filename, piece, quote, message));
    const answer = extractJson(raw) as { present?: unknown; reason?: unknown } | null;
    const present = typeof answer?.present === 'boolean' ? answer.present : null;
    const reason = typeof answer?.reason === 'string' ? answer.reason.slice(0, 200) : '';
    this.log.log(`re-check question on ${filename} for "${normalize(quote).slice(0, 60)}": present=${String(present)} ${reason}`);
    return { present, reason };
  }

  /** Cheap checks that need no AI. */
  ruleFindings(allChanged: DiffFile[]): ReviewedFinding[] {
    const sources = allChanged.filter((f) => SOURCE_EXT.test(f.filename) && !TEST_FILE.test(f.filename));
    const tests = allChanged.filter((f) => TEST_FILE.test(f.filename));
    if (sources.length === 0 || tests.length > 0) return [];

    // The identity must NOT depend on which files changed. It used to, so touching one more source file
    // changed the identity, and the old "add tests" ticket was closed as fixed without any test added.
    const quote = 'source changed without tests';
    const names = sources.map((f) => f.filename).sort();
    return [
      {
        source: 'RULE',
        category: 'missing_test',
        severity: 'LOW',
        file: names[0],
        title: 'Source changed without tests',
        quote,
        message: `Source files changed but no test file changed in this PR: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`,
        fingerprint: fingerprint('missing_test', 'pull-request', undefined, quote),
      },
    ];
  }

  /**
   * Save findings. The unique index (pullRequestId, fingerprint) means the same issue
   * found again on a later push updates the existing row instead of creating a duplicate.
   */
  async saveFindings(
    runId: number,
    pullRequestId: number,
    findings: ReviewedFinding[],
    commitSha?: string,
    patches?: Map<string, string | undefined>,
  ) {
    const existing = await this.prisma.finding.findMany({
      where: { pullRequestId, source: { in: ['AI', 'RULE'] } },
      select: { id: true, fingerprint: true, file: true, quote: true, source: true },
    });
    const known = new Set(existing.map((e) => e.fingerprint));
    // The fingerprints of everything this push found again. The re-check needs them.
    const seen = new Set<string>();
    let seenBefore = 0;

    for (const f of findings) {
      // The model may quote the same code a little differently each time (a shorter or longer part of the
      // line). Same file and overlapping code means it is the finding you already know, not a new one.
      let fp = f.fingerprint;
      if (!known.has(fp) && f.source === 'AI') {
        // ...but only while the old code is still there. If the old line was edited, a similar quote is a
        // different problem, and linking it would keep a fixed ticket open for ever.
        const same = existing.find(
          (e) =>
            e.source === 'AI' && e.file === f.file && sameCode(e.quote, f.quote) && quoteStillInCode(patches?.get(e.file), e.quote),
        );
        if (same) fp = same.fingerprint;
      }
      seen.add(fp);
      const wasKnown = known.has(fp);
      if (wasKnown) seenBefore++;
      const isRule = f.source === 'RULE';
      const row = await this.prisma.finding.upsert({
        where: { pullRequestId_fingerprint: { pullRequestId, fingerprint: fp } },
        update: { lastSeenRunId: runId, ...(isRule ? { message: f.message, file: f.file } : {}) },
        create: {
          pullRequestId,
          firstRunId: runId,
          lastSeenRunId: runId,
          fingerprint: fp,
          source: f.source,
          category: f.category,
          severity: f.severity,
          file: f.file,
          functionName: f.functionName,
          title: f.title,
          quote: f.quote,
          message: f.message,
          suggestedFix: f.suggestedFix,
          confidence: f.confidence,
        },
      });
      if (!wasKnown) {
        known.add(fp);
        await logEvent(this.prisma, row.id, 'FOUND', `Found by ${f.source === 'AI' ? 'the AI review' : 'a rule check'}${commitSha ? ` on commit ${shortSha(commitSha)}` : ''}`, 'system', commitSha);
      }
    }
    const created = findings.length - seenBefore;
    this.log.log(`run ${runId}: ${created} new findings, ${findings.length - created} seen again`);
    return { created, seenAgain: findings.length - created, seen };
  }
}
