export interface ProposedFinding {
  category: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  functionName?: string;
  title?: string;
  quote: string;
  message: string;
  suggestedFix?: string;
  confidence?: string;
}

/** Models sometimes wrap JSON in text. Try the whole string, then the {...} part. */
export function extractJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** How many findings we keep per file. More than this are counted, not silently lost. */
export const MAX_FINDINGS_PER_FILE = 15;

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** How many findings the model sent in total (before the limit and the validation). */
export function proposedCount(raw: string): number {
  const root = extractJson(raw) as { findings?: unknown } | null;
  return root && Array.isArray(root.findings) ? root.findings.length : 0;
}

/** Validate the model output. Anything malformed is dropped, never trusted. */
export function parseProposed(raw: string): ProposedFinding[] {
  const root = extractJson(raw) as { findings?: unknown } | null;
  if (!root || !Array.isArray(root.findings)) return [];

  const out: ProposedFinding[] = [];
  for (const item of root.findings.slice(0, MAX_FINDINGS_PER_FILE)) {
    if (typeof item !== 'object' || item === null) continue;
    const i = item as Record<string, unknown>;
    const category = asString(i.category);
    // Keep the quote exactly as the model sent it. The review step removes a leading diff "+" only
    // when the quote is not found as written (a line of code can really start with "+").
    const quote = asString(i.quote);
    const message = asString(i.message);
    if (!category || !quote || !message) continue;

    const sev = asString(i.severity).toUpperCase();
    out.push({
      category,
      severity: sev === 'HIGH' || sev === 'LOW' ? sev : 'MEDIUM',
      functionName: asString(i.function) || undefined,
      title: asString(i.title).replace(/`/g, '').slice(0, 80) || undefined,
      quote,
      message,
      suggestedFix: asString(i.suggested_fix) || undefined,
      confidence: CONFIDENCE.has(asString(i.confidence).toLowerCase()) ? asString(i.confidence).toLowerCase() : undefined,
    });
  }
  return out;
}
