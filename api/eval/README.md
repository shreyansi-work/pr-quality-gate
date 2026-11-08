# Bug detection evaluation

Measures how many planted bugs the AI review finds, and how much noise it makes. It uses the same code path as the
product (`filterFiles` then `ReviewService.reviewFiles`) and the AI from `.env` (`LLM_PROVIDER`). It never touches the
database, GitHub or the real findings.

## Run it

```bash
cd api
npm run eval                        # needs the AI to be reachable (Ollama running, or GROQ_API_KEY set)
EVAL_LABEL=baseline EVAL_RUNS=3 npm run eval   # name the run and average 3 runs
EVAL_DELAY_MS=3000 npm run eval     # wait between model calls (free plans have per-minute limits)
EVAL_SPLIT=tune npm run eval        # only the tuning files (all, tune or holdout; default all)
npm test                            # the unit tests of the evaluation itself (no AI needed)
npm run eval:baseline               # accept the newest run as eval/baseline.json
npm run eval:gate                   # fail if the newest run is worse than the baseline (no AI call)
```

## Tuning set and held-out set

Every file is tagged `tune` or `holdout` in `expected.json`. Study and tune against `tune` only. Run `holdout`
only at milestones, to check that an improvement is real and not just learned from the files you looked at.
Never read the held-out misses while you change the prompt.

## The gate

`npm run eval:gate` compares the newest run in `eval/results` with `eval/baseline.json`. It fails when the detection
rate falls by more than 3 points or the false positive share rises by more than 5 points (change them with
`GATE_MAX_DETECTION_DROP` and `GATE_MAX_FP_RISE`), when the suite version or split differs, or when a file could not be
reviewed. With `EVAL_RUNS=3` it compares the means. After a change you accept, run `npm run eval:baseline` and commit
`eval/baseline.json`. `.github/workflows/eval-gate.yml` runs the same steps on GitHub (needs a `GROQ_API_KEY` secret).

Each run writes `eval/results/<time>-<label>.json` and `.md`. The Markdown report has the numbers, the missed bugs with
their likely cause, the false positives, and a comparison with the previous run in that folder.

## What is measured

| Metric | Meaning |
|---|---|
| Detection rate | detected / planted x 100 |
| False positives | findings that are not a planted bug (on a clean file, or on a buggy file but not at a planted bug) |
| False positive share | false positives / all findings |
| Clean files flagged | clean files with at least one finding / clean files |
| Duplicates | extra findings on a bug that was already found |

A finding counts as a detection only when it is in the right file, points at the bug's lines (within 2 lines) and its
category fits (same group, a related group, or `other`). This is a heuristic: the report lists every match so you can
read it once. A finding on a buggy file that matches no planted bug is counted as a false positive, but it may be a real
bug nobody planted; read that list too.

## Files

- `cases/*.txt` the code under test. Plain text on purpose, so it is never compiled, linted or run.
- `expected.json` the answer key (id, file, category, anchor line, explanation). The model never sees it.
- `suite.ts`, `match.ts`, `metrics.ts`, `causes.ts`, `report.ts`, `store.ts`, `runner.ts`, `repeat.ts`, `gate.ts` the evaluation code.
- `run.eval.ts` the entry of `npm run eval`, `gate.eval.ts` of `npm run eval:gate`, `promote.mjs` of `npm run eval:baseline`. `eval.spec.ts` the tests.

## Add a bug

1. Add the code to a file in `cases/` (no comments that hint at the bug).
2. Add an entry to `expected.json` with an `anchor`: text that appears exactly once, on the first line of the bug.
   `span` is how many lines after it still belong to the bug.
3. Run `npm test`. It fails if an anchor is missing or appears twice. Give the file a `split`. Then raise `version` in
   `expected.json` and make a new baseline, because old runs are not comparable with the new suite.

## Limits to keep in mind

- Every file is reviewed as a brand-new file (the whole file is the diff). Changes to existing files are not covered.
- 100 bugs is better than 30 but still small. The model has some randomness: use `EVAL_RUNS=3` and compare means.
- The suite is yours to tune. If you tune the prompt until these 30 pass, add new bugs before you trust the rate.
