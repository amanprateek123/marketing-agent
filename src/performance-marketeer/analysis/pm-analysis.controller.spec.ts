import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PmAnalysisController } from './pm-analysis.controller';
import { PmAnalysisService } from './pm-analysis.service';
import { PmEnv } from '../pm.config';

describe('PmAnalysisController', () => {
  const service = {
    summary: jest.fn().mockResolvedValue('ok'),
    trend: jest.fn().mockResolvedValue('ok'),
    funnel: jest.fn().mockResolvedValue('ok'),
    report: jest.fn().mockResolvedValue('ok'),
  };
  const c = new PmAnalysisController(
    service as unknown as PmAnalysisService,
    { tenantId: '91astrology' } as PmEnv,
  );
  const ok = { from: '2026-10-18', to: '2026-10-24' };

  it('validates tenant, dates, product, level and string-only params', () => {
    expect(() => c.summary('other', ok)).toThrow(NotFoundException);
    expect(() =>
      c.summary('91astrology', { from: '2026-10-24', to: '2026-10-18' }),
    ).toThrow(BadRequestException);
    expect(() =>
      c.summary('91astrology', { from: '2026-01-01', to: '2026-10-18' }),
    ).toThrow(/200 days/);
    expect(() => c.summary('91astrology', { ...ok, product: 'other' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      c.summary('91astrology', { ...ok, product: { $ne: 'x' } }),
    ).toThrow(BadRequestException);
    expect(() => c.trend('91astrology', { ...ok, level: 'ad' })).toThrow(
      /id is required/,
    );
    expect(() => c.trend('91astrology', { ...ok, level: 'nope' })).toThrow(
      BadRequestException,
    );
    expect(() => c.funnel('91astrology', { ...ok, channel: 'tiktok' })).toThrow(
      BadRequestException,
    );
    expect(() => c.report('91astrology', { date: '24-10-2026' })).toThrow(
      BadRequestException,
    );
    expect(() => c.report('91astrology', { product: 'nope' })).toThrow(
      BadRequestException,
    );
    c.report('91astrology', { date: '2026-10-24', product: 'nadi-report' });
    expect(service.report).toHaveBeenCalledWith('2026-10-24', 'nadi-report');
    c.summary('91astrology', { ...ok, product: 'nadi-report' });
    expect(service.summary).toHaveBeenCalledWith({
      ...ok,
      product: 'nadi-report',
    });
    c.trend('91astrology', { ...ok, level: 'ad', id: '120249078503000403' });
    expect(service.trend).toHaveBeenCalledWith(ok, 'ad', '120249078503000403');
  });
});
