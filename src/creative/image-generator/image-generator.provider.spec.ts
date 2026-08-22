import { ImageGeneratorService } from './image-generator.service';

describe('ImageGeneratorService provider override', () => {
  function makeService(configuredProvider: string) {
    const configService = {
      get: jest.fn((key: string) =>
        key === 'imageGen.provider' ? configuredProvider : undefined,
      ),
    };
    const service = new ImageGeneratorService(
      {} as any,
      {} as any,
      configService as any,
      {} as any,
    );
    (service as any).callGptImage = jest
      .fn()
      .mockResolvedValue(Buffer.from('openai'));
    (service as any).callNanoBanana = jest
      .fn()
      .mockResolvedValue(Buffer.from('gemini'));
    (service as any).uploadBufferToS3 = jest
      .fn()
      .mockResolvedValue('https://cdn.example/image.png');
    return service;
  }

  it('uses OpenAI for one call even when the global provider is Nano Banana', async () => {
    const service = makeService('nano_banana');

    const result = await service.generateFromPrompt(
      'A reviewed prompt',
      { tenantId: 'tenant-1' } as any,
      'run-1',
      '1:1',
      '1K',
      'gpt_image',
    );

    expect(result.imageUrl).toBe('https://cdn.example/image.png');
    expect((service as any).callGptImage).toHaveBeenCalledTimes(1);
    expect((service as any).callNanoBanana).not.toHaveBeenCalled();
  });

  it('keeps the configured provider when no per-call override is supplied', async () => {
    const service = makeService('nano_banana');

    await service.generateFromPrompt(
      'A reviewed prompt',
      { tenantId: 'tenant-1' } as any,
      'run-1',
    );

    expect((service as any).callNanoBanana).toHaveBeenCalledTimes(1);
    expect((service as any).callGptImage).not.toHaveBeenCalled();
  });
});
