import { ValidationPipe } from '@nestjs/common';
import { StartRunDto } from './dto/start-run.dto';

/**
 * The disclaimer choice has to survive the whitelist to reach the pipeline.
 *
 * Exactly the shape of the `offering` incident this directory already has a spec for:
 * `ValidationPipe({ whitelist: true })` in main.ts DELETES any property the DTO does not declare,
 * with no error and nothing logged, so the operator's selection simply vanishes.
 *
 * What it carries matters here. Astrology creatives used to receive a disclaimer from the
 * director guide's claim-type table with nobody ever asked — 19 of 31 recent briefs carried one,
 * 10 of them "*For guidance only. T&C apply." The operator now chooses, and "none" is a real
 * choice, so a silently dropped field would put the unwanted disclaimer straight back.
 */
describe('StartRunDto disclaimer_choice', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: StartRunDto };

  const transform = (body: Record<string, unknown>) =>
    pipe.transform(body, meta) as Promise<StartRunDto>;

  it('survives the whitelist instead of being silently stripped', async () => {
    const out = await transform({
      method: 'create',
      prompt: 'a nadi report ad',
      disclaimer_choice: 'none',
    });
    expect(out.disclaimer_choice).toBe('none');
  });

  it('accepts every astro wording the pipeline serves', async () => {
    for (const choice of ['none', 'guidance', 'tnc', 'guidance_tnc', 'results_vary']) {
      const out = await transform({ method: 'create', prompt: 'p', disclaimer_choice: choice });
      expect(out.disclaimer_choice).toBe(choice);
    }
  });

  it('is optional — omitting it means the pipeline applies the domain default', async () => {
    const out = await transform({ method: 'create', prompt: 'p' });
    expect(out.disclaimer_choice).toBeUndefined();
  });

  it('does not validate the value list here', async () => {
    // Deliberate: the legal values differ by domain and the pipeline owns them, answering 400
    // with the allowed set. A second copy of that list here is the drift this repo keeps paying
    // for — see the `count` note in the DTO.
    const out = await transform({ method: 'create', prompt: 'p', disclaimer_choice: 'anything' });
    expect(out.disclaimer_choice).toBe('anything');
  });

  it('proves the whitelist really does drop undeclared fields', async () => {
    // Guards the first test from passing for the wrong reason.
    const out = (await transform({
      method: 'create',
      prompt: 'p',
      notAFieldWeDeclare: 'x',
    })) as unknown as Record<string, unknown>;
    expect(out.notAFieldWeDeclare).toBeUndefined();
  });
});
