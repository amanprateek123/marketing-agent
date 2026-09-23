import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AddOfferingDto } from './dto/add-offering.dto';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * Onboarding a product from its landing page.
 *
 * Two things are easy to get silently wrong here, and both are pinned below.
 *
 * 1. The whitelist. `main.ts` registers `ValidationPipe({ whitelist: true })`, which DELETES any
 *    property the DTO does not declare — no error, nothing logged. That is exactly how the product
 *    selection on the brief form went missing for 66 runs, so every field this DTO is supposed to
 *    forward is asserted to survive it.
 * 2. The forwarding. Declaring a field and then not passing it on looks identical from outside.
 */
describe('AddOfferingDto + addOffering', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: AddOfferingDto };

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

  function serviceWith(response: unknown) {
    const service = new PipelineBridgeService(config);
    const request = jest.fn().mockResolvedValue({ data: response });
    (service as unknown as { http: { request: jest.Mock } }).http = { request };
    return { service, request };
  }

  it('requires only the landing URL', async () => {
    const out = (await pipe.transform(
      { landing_url: 'https://www.91astrology.com/graha-kavach-report' },
      meta,
    )) as AddOfferingDto;

    expect(out.landing_url).toBe('https://www.91astrology.com/graha-kavach-report');
    expect(out.display_name).toBeUndefined();
    expect(out.slug).toBeUndefined();
  });

  it('keeps every optional field through the whitelist', async () => {
    const out = (await pipe.transform(
      {
        landing_url: 'https://www.91astrology.com/graha-kavach-report',
        display_name: 'Graha Kavach Report',
        slug: 'graha_kavach_report',
        no_render: true,
      },
      meta,
    )) as AddOfferingDto;

    expect(out.display_name).toBe('Graha Kavach Report');
    expect(out.slug).toBe('graha_kavach_report');
    expect(out.no_render).toBe(true);
  });

  it('rejects something that is not a URL, rather than failing inside the browser', async () => {
    await expect(
      pipe.transform({ landing_url: 'not a url at all' }, meta),
    ).rejects.toThrow();
  });

  it('rejects a missing landing URL', async () => {
    await expect(pipe.transform({ display_name: 'X' }, meta)).rejects.toThrow();
  });

  it('forwards the whole body to the pipeline', async () => {
    const { service, request } = serviceWith({ offering: { slug: 'graha_kavach_report' } });

    await service.addOffering('91astrology', {
      landing_url: 'https://www.91astrology.com/graha-kavach-report',
      display_name: 'Graha Kavach Report',
      no_render: false,
    } as AddOfferingDto);

    const sent = request.mock.calls[0][0] as { url: string; data: Record<string, unknown> };
    expect(sent.url).toBe('https://pipeline.example.com/v1/offerings');
    expect(sent.data.landing_url).toBe('https://www.91astrology.com/graha-kavach-report');
    expect(sent.data.display_name).toBe('Graha Kavach Report');
  });

  it('returns the pipeline payload, gaps included', async () => {
    // `gaps` is the operator's only signal that a pack was written but is thin, so it must not be
    // swallowed on the way back.
    const { service } = serviceWith({
      offering: { slug: 'graha_kavach_report', status: 'pilot' },
      gaps: ['price', 'testimonials'],
      note: 'Added and selectable.',
    });

    const out = (await service.addOffering('91astrology', {
      landing_url: 'https://www.91astrology.com/graha-kavach-report',
    } as AddOfferingDto)) as { gaps: string[] };

    expect(out.gaps).toEqual(['price', 'testimonials']);
  });
});
