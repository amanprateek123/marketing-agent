import { CampaignOptimizerService } from './campaign-optimizer.service';

describe('resolveSheetEntries carousel mode', () => {
  const assets = [
    { _id: 'a1', assetType: 'image', assetUrl: 'img1-916.jpg', aspectRatio: '9:16', sizes: [{ imageUrl: 'img1-11.jpg', aspectRatio: '1:1' }], sourcePackageId: 'p1', variantIndex: 0 },
    { _id: 'a2', assetType: 'video', assetUrl: 'vid.mp4', sourcePackageId: 'p1', variantIndex: 1 },
    { _id: 'a3', assetType: 'image', assetUrl: 'img2.jpg', sourcePackageId: 'p1', variantIndex: 2 },
    { _id: 'a4', assetType: 'image', assetUrl: 'img3.jpg', sourcePackageId: 'p1', variantIndex: 3 },
  ];
  const pkg = {
    _id: { toString: () => 'p1' },
    selectedCopyIndex: 0,
    copyVariants: [0, 1, 2, 3].map((i) => ({ primaryText: `text ${i}`, headline: `head ${i}`, cta: 'Learn More' })),
  };
  const service = new CampaignOptimizerService(
    {} as any,
    {} as any,
    {} as any,
    { listSheetAssets: async () => assets } as any,
    { find: () => ({ select: () => ({ lean: () => ({ exec: async () => [pkg] }) }) }) } as any,
  );
  const resolve = (excl: string[], opt?: any) => (service as any).resolveSheetEntries('t', 's', excl, opt);

  it('keeps images as separate ads by default', async () => {
    const { entries } = await resolve([]);
    expect(entries.map((e: any) => e.assetType)).toEqual(['image', 'video', 'image', 'image']);
  });

  it('groups selected images into one carousel in sheet order, videos stay separate', async () => {
    const { entries } = await resolve(['a4'], { imagesAs: 'carousel', carouselRatio: '1:1' });
    expect(entries.map((e: any) => e.assetType)).toEqual(['carousel', 'video']);
    expect(entries[0].copy.primaryText).toBe('text 0');
    expect(entries[0].cards).toEqual([
      { imageUrl: 'img1-11.jpg', headline: 'head 0' },
      { imageUrl: 'img2.jpg', headline: 'head 2' },
    ]);
  });

  it('refuses a carousel with fewer than 2 images', async () => {
    await expect(resolve(['a3', 'a4'], { imagesAs: 'carousel' })).rejects.toThrow(/at least 2/);
  });
});
