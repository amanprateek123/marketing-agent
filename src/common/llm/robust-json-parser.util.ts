/**
 * Robust JSON parser for LLM outputs.
 *
 * Replaces the ad-hoc `content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)`
 * pattern that lived at 7+ call sites. That pattern silently fails on:
 *   - Code-fenced JSON (```json ... ```) where the outer braces are inside the fence
 *   - Multiple top-level JSON blocks (the lastIndexOf catches the wrong closing brace)
 *   - Trailing commas that the LLM occasionally emits
 *   - LLM commentary before/after the JSON
 *   - Nested objects where the outermost { and last } don't align
 *
 * Strategy (in order, first success wins):
 *   1. Strip code fences (```json ... ``` or ``` ... ```) → JSON.parse
 *   2. Try the original slice(indexOf('{'), lastIndexOf('}') + 1) for back-compat
 *   3. Scan for the first balanced {...} block via brace counter → JSON.parse
 *   4. Strip trailing commas before } or ] inside any candidate string and retry
 *
 * Concrete failure this fixes (FAILED_ASTROTALK_TRUST_FLIGHT, 91astrology 2026-05-23):
 * Campaign Review Team produced output that the slice-parser couldn't read on
 * 2 retries → campaign killed before launch. A strong angle (competitor-displacement
 * vs AstroTalk fake-review scandal) was lost to a JSON formatting bug.
 */

export interface ParseRobustOptions {
  /**
   * When parsing fails, throw an error that includes both the underlying
   * message and a trimmed preview of the input. Useful for the retry-with-
   * feedback prompt to show the LLM what it returned.
   */
  includeInput?: boolean;
  /**
   * Maximum length of the input preview to embed in the error message.
   * Defaults to 500 chars.
   */
  inputPreviewChars?: number;
}

export class RobustJsonParseError extends Error {
  constructor(
    message: string,
    public readonly inputPreview: string,
    public readonly attempts: Array<{ strategy: string; error: string }>,
  ) {
    super(message);
    this.name = 'RobustJsonParseError';
  }
}

/**
 * Parse a JSON object from an LLM-generated string. Returns the parsed value,
 * throws RobustJsonParseError when every strategy fails.
 */
export function parseRobustJson<T = any>(
  content: string,
  options: ParseRobustOptions = {},
): T {
  const attempts: Array<{ strategy: string; error: string }> = [];
  const preview = (content ?? '').slice(0, options.inputPreviewChars ?? 500);

  if (!content || typeof content !== 'string') {
    throw new RobustJsonParseError('empty or non-string content', preview, attempts);
  }

  // Strategy 1: code fence
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    try {
      return JSON.parse(inner) as T;
    } catch (err: any) {
      attempts.push({ strategy: 'code-fence', error: err.message });
      // Try trailing-comma repair on the fenced content
      try {
        return JSON.parse(stripTrailingCommas(inner)) as T;
      } catch (err2: any) {
        attempts.push({ strategy: 'code-fence+trailing-comma-strip', error: err2.message });
      }
    }
  }

  // Strategy 2: legacy slice — keep for back-compat with simple cases.
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = content.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(sliced) as T;
    } catch (err: any) {
      attempts.push({ strategy: 'legacy-slice', error: err.message });
    }
  }

  // Strategy 3: walk braces to extract the FIRST balanced top-level object.
  // This handles "LLM commentary ```{...}``` more commentary {...other thing}".
  const balanced = extractFirstBalancedObject(content);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch (err: any) {
      attempts.push({ strategy: 'balanced-walk', error: err.message });
      try {
        return JSON.parse(stripTrailingCommas(balanced)) as T;
      } catch (err2: any) {
        attempts.push({ strategy: 'balanced-walk+trailing-comma-strip', error: err2.message });
      }
    }
  }

  // Strategy 4: trailing-comma repair on the legacy slice.
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = content.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(stripTrailingCommas(sliced)) as T;
    } catch (err: any) {
      attempts.push({ strategy: 'legacy-slice+trailing-comma-strip', error: err.message });
    }
  }

  const detail = attempts.map(a => `${a.strategy}: ${a.error}`).join(' | ');
  throw new RobustJsonParseError(
    `All JSON parse strategies failed. Last error chain: ${detail}`,
    preview,
    attempts,
  );
}

/**
 * Strip trailing commas before } or ] — invalid JSON but a common LLM output bug.
 * Naive but effective: ignores commas inside string literals via a tiny state walker.
 */
export function stripTrailingCommas(s: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  let strQuote = '"';
  while (i < s.length) {
    const c = s[i];
    if (inString) {
      out.push(c);
      if (c === '\\' && i + 1 < s.length) { out.push(s[i + 1]); i += 2; continue; }
      if (c === strQuote) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; strQuote = c; out.push(c); i++; continue; }
    if (c === ',') {
      // Look ahead past whitespace for } or ]
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') { i = j; continue; }   // skip the comma
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * Walk the string and return the substring of the first balanced top-level
 * JSON object ({ ... }). Returns null if no balanced object is found.
 *
 * Handles nested braces inside strings (and escaped quotes) correctly.
 */
export function extractFirstBalancedObject(s: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let strQuote = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === strQuote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; strQuote = c; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
      if (depth < 0) {
        // Unbalanced — reset and continue scanning.
        depth = 0;
        start = -1;
      }
    }
  }
  return null;
}
