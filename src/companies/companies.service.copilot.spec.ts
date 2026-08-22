import { CompaniesService } from './companies.service';

describe('CompaniesService Campaign Copilot product writes', () => {
  it('uses a tenant-scoped conditional $push instead of replacing products', async () => {
    const updated = { tenantId: 'tenant-1', products: [] };
    const exec = jest.fn().mockResolvedValue(updated);
    const companyModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({ exec }),
    };
    const service = new CompaniesService(companyModel as any);
    const product = {
      name: 'New (Premium) Product',
      price: 1_499,
      currency: 'INR',
      description: 'New product',
      active: true,
    } as any;

    await expect(
      service.appendCopilotProductIfAbsent(
        'tenant-1',
        'newpremiumproduct',
        product,
      ),
    ).resolves.toBe(updated);

    expect(companyModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        products: {
          $not: {
            $elemMatch: {
              $or: [
                { copilotProductKey: 'newpremiumproduct' },
                {
                  name: {
                    $regex: '^New \\(Premium\\) Product$',
                    $options: 'i',
                  },
                },
              ],
            },
          },
        },
      },
      {
        $push: {
          products: { ...product, copilotProductKey: 'newpremiumproduct' },
        },
      },
      { new: true },
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('fills existing product fields without replacing the products array', async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    const current = {
      tenantId: 'tenant-1',
      products: [{ name: 'Product One', pixelId: 'pixel-1' }],
    };
    const companyModel = {
      updateOne,
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(current),
      }),
    };
    const service = new CompaniesService(companyModel as any);

    await expect(
      service.fillMissingCopilotProductFields('tenant-1', 'Product One', {
        pixelId: 'pixel-1',
        pageId: 'page-1',
      }),
    ).resolves.toBe(current);

    expect(updateOne).toHaveBeenCalledTimes(2);
    for (const call of updateOne.mock.calls) {
      expect(call[0]).toEqual({
        tenantId: 'tenant-1',
        'products.name': 'Product One',
      });
      expect(call[1]).toHaveProperty('$set');
      expect(call[1]).not.toHaveProperty('$push');
      expect(call[1]).not.toHaveProperty('products');
      expect(call[2]).toHaveProperty('arrayFilters');
    }
  });
});
