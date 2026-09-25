import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A creative action that cannot run must answer with a FAILURE STATUS, never a 200.
 *
 * The dashboard's detail page starts these actions and then polls the package for a changed
 * image/video URL, clearing its spinner only when the URL moves. `apiFetch` throws on a non-2xx,
 * so a real error status surfaces immediately — but a 200 carrying an `{ error }` body is
 * indistinguishable from "started", and the button span for its whole 3-minute poll budget and
 * then gave up without saying anything.
 *
 * That was diagnosed once for Retry — the note in the detail page's `pollUntil` records it
 * verbatim: "returned 200 with an {error} body because a pushed package has no imagePrompt — the
 * UI then span for three minutes and gave up silently" — and fixed only by routing Retry
 * elsewhere. The same defect was still live on Rewrite, Edit and both video buttons, which is what
 * made "the rewrite button keeps loading" a real report.
 *
 * Asserted against the source text rather than by booting the controller: the handlers each need a
 * Mongo model, a company and a brief to reach the guard, and the thing worth pinning is simply
 * that no guard in this file returns a failure as a 200.
 */
describe('creative.controller failure responses', () => {
  const source = readFileSync(
    join(__dirname, 'creative.controller.ts'),
    'utf8',
  );

  it('never returns an { error } body as a 200', () => {
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /return\s*\{\s*error:/.test(line));

    expect(offenders).toEqual([]);
  });

  it('still guards the states that used to return 200 — they now throw', () => {
    // The guards must not have been deleted to make the test above pass.
    for (const guard of [
      'No brief found for this creative',
      'No imagePrompt saved for variant',
      'No image exists yet for variant',
      'No videoPrompt saved',
    ]) {
      expect(source).toContain(guard);
    }
    expect(source).toContain('UnprocessableEntityException');
  });

  it('imports the exception it throws', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*UnprocessableEntityException[^}]*\}\s*from\s*'@nestjs\/common'/,
    );
  });
});
