import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StartRunDto } from './dto/start-run.dto';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * The per-creative slot plan (SLOT-CONTRACT.md, 2026-09-30): the creative form now says, for each
 * creative in a batch, which angle / look / hook it should be. The pipeline treats those fields as
 * the source of truth — so if `ValidationPipe({ whitelist: true })` strips `slots` (undeclared), or
 * strips a key INSIDE a slot (nested class that does not know it), the operator's plan silently
 * becomes "the pipeline decides" with no error anywhere. These tests pin that the whole slot
 * survives, that malformed slots are refused rather than half-kept, and that the bridge forwards it.
 */
describe('StartRunDto slots', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: StartRunDto };

  const fullSlot = {
    slot: 1,
    track: 'raw',
    language: 'Hindi',
    angle: 'pain_point',
    hook_type: 'question',
    visual_direction: 'zero_text_photo',
    hypothesis_id: 412,
    hypothesis_kind: 'variant',
    hypothesis_statement: 'hook_type = fear beats question on ctr_pct by 10%',
    note: 'keep it quiet',
  };

  it('keeps every contract key of every slot through the whitelist', async () => {
    const out = (await pipe.transform(
      {
        method: 'create',
        prompt: 'p',
        count: '2',
        slots: [fullSlot, { slot: 2, angle: 'curiosity' }],
      },
      meta,
    )) as StartRunDto;

    expect(out.slots).toHaveLength(2);
    expect({ ...out.slots![0] }).toEqual(fullSlot);
    expect({ ...out.slots![1] }).toEqual({ slot: 2, angle: 'curiosity' });
  });

  it('strips unknown keys inside a slot, not the slot itself', async () => {
    const out = (await pipe.transform(
      {
        method: 'create',
        prompt: 'p',
        slots: [{ slot: 1, angle: 'urgency', junk: 'x' }],
      },
      meta,
    )) as StartRunDto;

    expect({ ...out.slots![0] }).toEqual({ slot: 1, angle: 'urgency' });
  });

  it('keeps tracks (the weighted per-creative style mix)', async () => {
    const out = (await pipe.transform(
      { method: 'create', prompt: 'p', tracks: ['polished', 'raw'] },
      meta,
    )) as StartRunDto;

    expect(out.tracks).toEqual(['polished', 'raw']);
  });

  it.each([
    ['slot below 1', { slot: 0 }],
    ['slot not an integer', { slot: 1.5 }],
    ['unknown track', { slot: 1, track: 'glossy' }],
    ['unknown hypothesis kind', { slot: 1, hypothesis_kind: 'hunch' }],
    ['hypothesis id not an integer', { slot: 1, hypothesis_id: 'H12' }],
    [
      'statement over 500 chars',
      { slot: 1, hypothesis_statement: 'x'.repeat(501) },
    ],
    ['note over 500 chars', { slot: 1, note: 'x'.repeat(501) }],
    ['slot missing', { angle: 'pain_point' }],
  ])('refuses a malformed slot (%s)', async (_label, slot) => {
    await expect(
      pipe.transform({ method: 'create', prompt: 'p', slots: [slot] }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stays optional — a brief without a plan is unchanged', async () => {
    const out = (await pipe.transform(
      { method: 'create', prompt: 'p', angles: ['pain_point'] },
      meta,
    )) as StartRunDto;

    expect(out.slots).toBeUndefined();
    expect(out.tracks).toBeUndefined();
    expect(out.angles).toEqual(['pain_point']);
  });

  it('accepts shape_reference_with_text as an image direction', async () => {
    const out = (await pipe.transform(
      {
        method: 'create',
        prompt: 'p',
        image_refs: [{ filename: 'a.png', s3_url: null }],
        image_direction: 'shape_reference_with_text',
      },
      meta,
    )) as StartRunDto;

    expect(out.image_direction).toBe('shape_reference_with_text');
  });

  it('forwards slots and tracks to the pipeline, not just parses them', async () => {
    const config = {
      get: (key: string) =>
        (
          ({
            'pipeline.url': 'https://pipeline.example.com',
            'pipeline.token': 'test-token',
            'pipeline.timeoutMs': 1000,
          }) as Record<string, unknown>
        )[key],
    } as unknown as ConfigService;

    const service = new PipelineBridgeService(config);
    const request = jest.fn().mockResolvedValue({ data: { run_id: 1 } });
    (service as unknown as { http: { request: jest.Mock } }).http = { request };

    // Through the pipe first, exactly as the controller receives it (class instances, not plain).
    const dto = (await pipe.transform(
      {
        method: 'create',
        prompt: 'p',
        tracks: ['raw'],
        slots: [fullSlot],
      },
      meta,
    )) as StartRunDto;
    await service.startRun('91astrology', dto);

    const sent = request.mock.calls[0][0] as { data: Record<string, unknown> };
    // Round-trip through JSON: what axios actually puts on the wire.
    const wire = JSON.parse(JSON.stringify(sent.data)) as Record<
      string,
      unknown
    >;
    expect(wire.slots).toEqual([fullSlot]);
    expect(wire.tracks).toEqual(['raw']);
    expect(wire.tenant_id).toBe('91astrology');
  });
});
