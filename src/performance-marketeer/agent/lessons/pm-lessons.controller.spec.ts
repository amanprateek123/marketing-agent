import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PmEnv } from '../../pm.config';
import { PmLessonsController } from './pm-lessons.controller';
import { PmLessonsService } from './lessons.service';

// Unit test of validation/wiring only: keep the service's Mongo schemas out of the module graph.
jest.mock('./lessons.service', () => ({ PmLessonsService: class {} }));

describe('PmLessonsController', () => {
  const svc = {
    listLessons: jest.fn().mockResolvedValue([]),
    listProposals: jest.fn().mockResolvedValue([]),
    approve: jest.fn().mockResolvedValue({}),
    reject: jest.fn().mockResolvedValue({}),
    editLesson: jest.fn().mockResolvedValue({}),
    retire: jest.fn().mockResolvedValue({}),
    ownerRules: jest.fn().mockResolvedValue([]),
    createOwnerRule: jest.fn().mockResolvedValue({}),
    updateOwnerRule: jest.fn().mockResolvedValue({}),
    deleteOwnerRule: jest.fn().mockResolvedValue({}),
    scorecard: jest.fn().mockResolvedValue({}),
  };
  const c = new PmLessonsController(
    svc as unknown as PmLessonsService,
    { tenantId: '91astrology' } as PmEnv,
  );
  const T = '91astrology';
  beforeEach(() => jest.clearAllMocks());

  it('rejects other tenants and bad filters before touching the service', () => {
    expect(() => c.list('other', {})).toThrow(NotFoundException);
    expect(() => c.list(T, { status: 'live' })).toThrow(BadRequestException);
    expect(() => c.list(T, { type: { $ne: 1 } })).toThrow(BadRequestException);
    expect(() => c.approve(T, 'bad id!', {})).toThrow(BadRequestException);
    expect(() => c.scorecard(T, { weeks: '99' })).toThrow(BadRequestException);
    expect(svc.listLessons).not.toHaveBeenCalled();
  });

  it('passes filters, notes and defaults through', async () => {
    await c.list(T, { status: 'active', type: 'action_effect' });
    expect(svc.listLessons).toHaveBeenCalledWith({
      status: 'active',
      type: 'action_effect',
    });
    await c.approve(T, 'P-2026-W43-1', { note: '  ok ' });
    expect(svc.approve).toHaveBeenCalledWith('P-2026-W43-1', 'ok');
    await c.reject(T, 'P-1', { note: ' too few cases ' });
    expect(svc.reject).toHaveBeenCalledWith('P-1', 'too few cases');
    expect(() => c.reject(T, 'P-1', { note: '   ' })).toThrow(
      BadRequestException,
    );
    await c.scorecard(T, {});
    expect(svc.scorecard).toHaveBeenCalledWith(8);
  });

  it('validates scope keys on edit', async () => {
    expect(() => c.edit(T, 'L-1', { scope: { color: 'red' } })).toThrow(
      BadRequestException,
    );
    expect(() => c.edit(T, 'L-1', { scope: { roas7d: 1.1 } })).toThrow(
      BadRequestException,
    );
    expect(() => c.edit(T, 'L-1', {})).toThrow(BadRequestException);
    await c.edit(T, 'L-1', { scope: { structure: 'ABO|CBO', phase: 'plan' } });
    expect(svc.editLesson).toHaveBeenCalledWith('L-1', {
      scope: { structure: 'ABO|CBO', phase: 'plan' },
    });
  });

  it('validates owner-rule checks', async () => {
    expect(() =>
      c.createOwnerRule(T, { text: 'x', check: { kind: 'nope' } }),
    ).toThrow(BadRequestException);
    expect(() =>
      c.createOwnerRule(T, {
        text: 'x',
        check: { kind: 'max_budget_step', step: 2 },
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      c.createOwnerRule(T, {
        text: 'x',
        check: { kind: 'no_action_type', type: 'launch' },
      }),
    ).toThrow(BadRequestException);
    await c.createOwnerRule(T, {
      text: ' Never pause before day 3 ',
      check: { kind: 'no_pause_before_days', days: 3, extra: 1 },
    });
    expect(svc.createOwnerRule).toHaveBeenCalledWith({
      text: 'Never pause before day 3',
      active: true,
      check: { kind: 'no_pause_before_days', days: 3 },
    });
    await c.updateOwnerRule(T, 'R-1', { check: null });
    expect(svc.updateOwnerRule).toHaveBeenCalledWith('R-1', { check: null });
  });
});
