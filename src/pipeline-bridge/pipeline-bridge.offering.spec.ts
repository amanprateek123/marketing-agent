import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StartRunDto } from './dto/start-run.dto';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * The product (`offering`) has to survive two layers to reach the pipeline, and it was declared in
 * neither — so a dashboard astro creative arrived with no product at all. The pipeline then stamped
 * `research_slug` NULL and fell back to its manifest default, authoring every brief from the Nadi
 * research pack, filing it in the Nadi S3 folder and labelling it "Nadi Report" whatever the
 * operator actually asked for. 66 runs in 30 days (measured 2026-09-23).
 *
 * Layer 1 is `ValidationPipe({ whitelist: true })` from main.ts, which silently DELETES any
 * property the DTO does not declare — no error, nothing logged, the selection simply vanishes.
 * (Layer 2 was Pydantic's ignore-unknown on the pipeline's own StartRunBody, fixed there.)
 *
 * These tests pin both halves: the field survives the whitelist, and `startRun` actually forwards
 * it. Declaring it without forwarding it looks identical from the outside.
 */
describe('StartRunDto offering', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: StartRunDto };

  it('survives the whitelist instead of being silently stripped', async () => {
    const out = (await pipe.transform(
      { method: 'create', prompt: 'a marriage-delay ad', offering: 'lal_kitab' },
      meta,
    )) as StartRunDto;

    expect(out.offering).toBe('lal_kitab');
  });

  it('proves the whitelist really does drop undeclared fields', async () => {
    // Guards the test above from passing for the wrong reason: if whitelist were off, the first
    // test would pass even with the field undeclared.
    const out = (await pipe.transform(
      { method: 'create', prompt: 'p', notAFieldWeDeclare: 'x' },
      meta,
    )) as Record<string, unknown>;

    expect(out).not.toHaveProperty('notAFieldWeDeclare');
  });

  it('stays optional, so automotive and research briefs are unaffected', async () => {
    const out = (await pipe.transform(
      { method: 'research', prompt: 'p' },
      meta,
    )) as StartRunDto;

    expect(out.offering).toBeUndefined();
  });

  it('is forwarded to the pipeline, not just parsed', async () => {
    const config = {
      get: (key: string) =>
        (
          {
            'pipeline.url': 'https://pipeline.example.com',
            'pipeline.token': 'test-token',
            'pipeline.timeoutMs': 1000,
          } as Record<string, unknown>
        )[key],
    } as unknown as ConfigService;

    const service = new PipelineBridgeService(config);
    const request = jest.fn().mockResolvedValue({ data: { run_id: 1 } });
    (service as unknown as { http: { request: jest.Mock } }).http = { request };

    await service.startRun('91astrology', {
      method: 'create',
      prompt: 'a marriage-delay ad',
      offering: 'saathi_report',
    } as StartRunDto);

    const sent = request.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(sent.data.offering).toBe('saathi_report');
    expect(sent.data.tenant_id).toBe('91astrology');
  });
});
