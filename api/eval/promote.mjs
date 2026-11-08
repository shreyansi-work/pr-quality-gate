// `npm run eval:baseline`: accept the newest run (or the file in EVAL_RESULT) as the baseline for the gate.
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const results = join(dir, 'results');
let source = process.env.EVAL_RESULT;
if (!source) {
  const names = existsSync(results) ? readdirSync(results).filter((n) => n.endsWith('.json')).sort() : [];
  if (names.length === 0) {
    console.error('No run found in eval/results. Run `npm run eval` first.');
    process.exit(1);
  }
  source = join(results, names[names.length - 1]);
}
copyFileSync(source, join(dir, 'baseline.json'));
console.log(`Baseline is now ${source}`);
console.log('Commit eval/baseline.json so the gate can use it.');
