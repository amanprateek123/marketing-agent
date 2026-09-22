import { ConfigService } from '@nestjs/config';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * `form-data` is a CommonJS module whose `module.exports` IS the constructor (`export = FormData`).
 * This project compiles with `module: commonjs` and WITHOUT `esModuleInterop`, so TypeScript emits a
 * bare `require()` with no interop wrapper — reading `.default` off it yields `undefined` at runtime
 * even though `allowSyntheticDefaultImports` lets it type-check cleanly.
 *
 * Every reference-image upload therefore died on `new FormData()` with
 * "TypeError: FormData is not a constructor", which NestJS reports as a 500. A brief with no images
 * never reaches this method, which is why the failure looked user-specific rather than total.
 */
describe('PipelineBridgeService.uploadImages', () => {
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

  const file = {
    originalname: 'reference.png',
    buffer: Buffer.from('not-really-a-png'),
    mimetype: 'image/png',
  };

  it('builds a multipart body and forwards it, rather than throwing', async () => {
    const service = new PipelineBridgeService(config);
    const request = jest.fn().mockResolvedValue({ data: { uploaded: 1 } });
    (service as unknown as { http: { request: jest.Mock } }).http = { request };

    await expect(service.uploadImages([file])).resolves.toEqual({ uploaded: 1 });

    const sent = request.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(sent.url).toBe('https://pipeline.example.com/v1/uploads');
    // The boundary must come from the form itself — that is the whole reason this path
    // bypasses `forward()`.
    expect(sent.headers['content-type']).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });
});
