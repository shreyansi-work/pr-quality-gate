import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { describe, it } from 'vitest';
import { GroqProvider } from '../src/llm/groq.provider.js';
import { LlmProvider } from '../src/llm/llm.provider.js';
import { OllamaProvider } from '../src/llm/ollama.provider.js';
import { REVIEW_SYSTEM, VERIFY_SYSTEM } from '../src/review/prompts.js';
import { ReviewService } from '../src/review/review.service.js';
import { aggregateRuns } from './repeat.js';
import { runSuite } from './runner.js';
import { EVAL_DIR, loadSuite, selectSplit } from './suite.js';
import type { EvalRun, Split } from './types.js';
import { loadPreviousRun, saveRun } from './store.js';

/**
 * Entry of `npm run eval`. It calls the real AI named in .env (LLM_PROVIDER) and writes api/eval/results/.
 * Nothing here touches the database, GitHub or the findings of the product.
 *
 * Optional environment variables:
 *   EVAL_LABEL      a name for this run, for example baseline or after-prompt-change
 *   EVAL_DELAY_MS   wait this long before every model call (free plans have per-minute limits)
 *   EVAL_RUNS       run the whole suite this many times and report the mean (default 1; use 3 to compare changes)
 *   EVAL_SPLIT      all (default), tune or holdout. Use holdout only at milestones, never while tuning.
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file: the variables may already be set */
}

/** Waits between calls and counts them. */
class PacedProvider extends LlmProvider {
  calls = 0;
  constructor(private readonly inner: LlmProvider, private readonly delayMs: number) {
    super();
  }
  get modelName() {
    return this.inner.modelName;
  }
  async completeJson(system: string, user: string): Promise<string> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.calls++;
    return this.inner.completeJson(system, user);
  }
}

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

describe('planted-bug evaluation', () => {
  it(
    'reviews the suite and writes a report',
    async () => {
      const config = new ConfigService();
      const providerName = process.env.LLM_PROVIDER === 'groq' ? 'groq' : 'ollama';
      const inner = providerName === 'groq' ? new GroqProvider(config) : new OllamaProvider(config);
      const llm = new PacedProvider(inner, num('EVAL_DELAY_MS', 0));
      const review = new ReviewService(llm, null as never, config);

      const splitName = (process.env.EVAL_SPLIT ?? 'all').toLowerCase();
      if (splitName !== 'all' && splitName !== 'tune' && splitName !== 'holdout') throw new Error('EVAL_SPLIT must be all, tune or holdout');
      const loaded = selectSplit(loadSuite(), splitName as Split | 'all');
      const repeats = Math.max(1, Math.floor(num('EVAL_RUNS', 1)));
      const promptVersion = createHash('sha256').update(REVIEW_SYSTEM + VERIFY_SYSTEM).digest('hex').slice(0, 8);
      const settings: Record<string, string> = {
        promptVersion,
        split: splitName,
        REVIEW_VERIFY: process.env.REVIEW_VERIFY ?? 'true',
        REVIEW_CHUNK_CHARS: String(num('REVIEW_CHUNK_CHARS', 12_000)),
        REVIEW_MAX_FILE_CHARS: String(num('REVIEW_MAX_FILE_CHARS', 36_000)),
        REVIEW_MAX_TOTAL_CHARS: String(num('REVIEW_MAX_TOTAL_CHARS', 80_000)),
      };
      if (providerName === 'ollama') settings.OLLAMA_NUM_CTX = String(num('OLLAMA_NUM_CTX', 16_384));

      const all: EvalRun[] = [];
      for (let n = 1; n <= repeats; n++) {
        all.push(
          await runSuite(review, loaded, llm.modelName, {
            label: process.env.EVAL_LABEL ?? 'run',
            provider: providerName,
            settings,
            maxFileChars: num('REVIEW_MAX_FILE_CHARS', 36_000),
            maxTotalChars: num('REVIEW_MAX_TOTAL_CHARS', 80_000),
            onFile: (path, i, total) => console.log(`[eval] run ${n}/${repeats}: ${i}/${total} ${path}`),
          }),
        );
        // the next run must get its own id, even when the first one finished within the same second
        await new Promise((r) => setTimeout(r, 1100));
      }
      const run = repeats > 1 ? aggregateRuns(all) : all[0];

      const dir = join(EVAL_DIR, 'results');
      const previous = loadPreviousRun(dir, run.id);
      const saved = saveRun(dir, run, previous);
      const m = run.metrics;
      const mean = run.repeat ? `, mean over ${run.repeat.runs} runs ${run.repeat.meanDetectionRate ?? 'n/a'}%` : '';
      console.log(
        `\n[eval] detected ${m.detected}/${m.planted} (${m.detectionRate ?? 'n/a'}%${mean}), false positives ${m.falsePositives}, duplicates ${m.duplicates}, ${llm.calls} model calls\n[eval] report: ${saved.markdown}\n`,
      );
    },
    3 * 60 * 60 * 1000,
  );
});
