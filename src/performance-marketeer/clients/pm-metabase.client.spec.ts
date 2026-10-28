import { assertSafePipeline } from './pm-metabase.client';

describe('assertSafePipeline', () => {
  const ok = [
    { $match: { status: 'ORDER_CONFIRMED' } },
    { $project: { _id: 0, id: 1, orderTotal: 1 } },
  ];

  it('accepts a read-only pipeline ending in a clean $project', () => {
    expect(() => assertSafePipeline('orders', ok)).not.toThrow();
  });

  it('rejects collections outside the allow-list', () => {
    expect(() => assertSafePipeline('users', ok)).toThrow(
      /Collection not allowed/,
    );
    expect(() => assertSafePipeline('otp', ok)).toThrow(
      /Collection not allowed/,
    );
  });

  it('rejects write and JavaScript operators anywhere', () => {
    expect(() => assertSafePipeline('orders', [...ok, { $out: 'x' }])).toThrow(
      /\$out/,
    );
    expect(() =>
      assertSafePipeline('orders', [{ $merge: { into: 'x' } }, ok[1]]),
    ).toThrow(/\$merge/);
    expect(() =>
      assertSafePipeline('orders', [{ $match: { $where: 'true' } }, ok[1]]),
    ).toThrow(/\$where/);
  });

  it('requires a final $project without personal fields', () => {
    expect(() => assertSafePipeline('orders', [{ $match: {} }])).toThrow(
      /end with a \$project/,
    );
    expect(() =>
      assertSafePipeline('orders', [{ $project: { address: 1 } }]),
    ).toThrow(/address/);
    expect(() =>
      assertSafePipeline('orders', [{ $project: { ip: '$clientIp' } }]),
    ).toThrow(/clientIp/);
    expect(() =>
      assertSafePipeline('orders', [{ $project: { 'kundliData.name': 1 } }]),
    ).toThrow(/kundliData/);
  });

  it('blocks the bypasses: other collections, $$ROOT, copies, exclusions, nested paths', () => {
    const end = { $project: { _id: 0, id: 1 } };
    expect(() =>
      assertSafePipeline('orders', [
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: 'id',
            as: 'u',
          },
        },
        end,
      ]),
    ).toThrow(/\$lookup/);
    expect(() =>
      assertSafePipeline('orders', [{ $unionWith: 'otp' }, end]),
    ).toThrow(/\$unionWith/);
    expect(() =>
      assertSafePipeline('orders', [{ $project: { x: '$$ROOT' } }]),
    ).toThrow(/ROOT/);
    expect(() =>
      assertSafePipeline('orders', [
        { $addFields: { x: '$address' } },
        { $project: { x: 1 } },
      ]),
    ).toThrow(/address/);
    expect(() =>
      assertSafePipeline('orders', [{ $project: { _id: 0 } }]),
    ).toThrow(/list the fields/);
    expect(() =>
      assertSafePipeline('orders', [{ $project: { kundliData: 0 } }]),
    ).toThrow();
    expect(() =>
      assertSafePipeline('orders', [{ $project: { 'shipping.phone': 1 } }]),
    ).toThrow(/phone/);
    expect(() =>
      assertSafePipeline('orders', [{ $replaceWith: '$additionalInfo' }, end]),
    ).toThrow(/\$replaceWith/);
  });

  it('accepts the pipelines the sync actually sends', () => {
    expect(() =>
      assertSafePipeline('transactions', [
        {
          $match: {
            orderId: { $in: ['a'] },
            $or: [{ type: 'REFUND' }, { refundedAt: { $exists: true } }],
          },
        },
        {
          $project: {
            _id: 0,
            orderId: 1,
            type: 1,
            transactionStatus: 1,
            amount: 1,
            refundedAt: 1,
            refundStatus: '$refundInfo.refundStatus',
          },
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertSafePipeline('transactions', [
        {
          $match: {
            $and: [
              { userId: { $in: ['u'] } },
              { transactionStatus: 'PAYMENT_SUCCESS' },
            ],
          },
        },
        {
          $project: {
            _id: 0,
            userId: 1,
            orderId: 1,
            transactionId: 1,
            at: { $toDate: '$_id' },
          },
        },
        { $sort: { at: 1 } },
        {
          $group: {
            _id: '$userId',
            first: {
              $firstN: {
                n: 2,
                input: {
                  orderId: '$orderId',
                  transactionId: '$transactionId',
                  at: '$at',
                },
              },
            },
          },
        },
        { $project: { _id: 0, userId: '$_id', first: 1 } },
      ]),
    ).not.toThrow();
  });
});
