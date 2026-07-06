import { EventEmitter2 } from '@nestjs/event-emitter';
import { EngineEventBus } from '../../../src/intelligence/shared/engine-event-bus.service';

describe('EngineEventBus', () => {
  let emitter: EventEmitter2;
  let bus: EngineEventBus;

  beforeEach(() => {
    emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
    bus = new EngineEventBus(emitter);
  });

  it('emits intelligence.<engine>.completed with correct payload', (done) => {
    emitter.on('intelligence.snapshot.completed', (payload) => {
      expect(payload.engine).toBe('snapshot');
      expect(payload.cycleId).toBe('c-1');
      expect(payload.confidence).toBe(0.85);
      done();
    });

    bus.emitCompleted({
      cycleId: 'c-1',
      tenantId: 't',
      campaignId: 'cam',
      engine: 'snapshot',
      at: new Date(),
      confidence: 0.85,
    });
  });

  it('emits intelligence.<engine>.failed', (done) => {
    emitter.on('intelligence.trend.failed', (payload) => {
      expect(payload.engine).toBe('trend');
      expect(payload.error).toBe('div_by_zero');
      done();
    });

    bus.emitFailed({
      cycleId: 'c-1',
      tenantId: 't',
      campaignId: 'cam',
      engine: 'trend',
      at: new Date(),
      error: 'div_by_zero',
    });
  });

  it('emits intelligence.<engine>.skipped with reason', (done) => {
    emitter.on('intelligence.revenue.skipped', (payload) => {
      expect(payload.reason).toBe('objective_not_sales');
      done();
    });

    bus.emitSkipped({
      cycleId: 'c-1',
      tenantId: 't',
      campaignId: 'cam',
      engine: 'revenue',
      at: new Date(),
      reason: 'objective_not_sales',
    });
  });

  it('emits intelligence.cycle.started + completed', (done) => {
    const seen: string[] = [];
    emitter.on('intelligence.cycle.started', () => seen.push('started'));
    emitter.on('intelligence.cycle.completed', () => {
      seen.push('completed');
      expect(seen).toEqual(['started', 'completed']);
      done();
    });
    bus.emitCycleStarted({ cycleId: 'c', tenantId: 't', campaignId: 'cam', at: new Date() });
    bus.emitCycleCompleted({
      cycleId: 'c',
      tenantId: 't',
      campaignId: 'cam',
      durationMs: 42,
      at: new Date(),
    });
  });

  it('emits an event whose name contains the engine key', () => {
    const emitSpy = jest.spyOn(emitter, 'emit');
    bus.emitCompleted({
      cycleId: 'c',
      tenantId: 't',
      campaignId: 'cam',
      engine: 'lifecycle',
      at: new Date(),
    });
    expect(emitSpy).toHaveBeenCalledWith(
      'intelligence.lifecycle.completed',
      expect.objectContaining({ engine: 'lifecycle' }),
    );
  });
});
