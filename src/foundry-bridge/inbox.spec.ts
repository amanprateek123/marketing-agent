import { NotImplementedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/roles';
import { InboxController } from './inbox.controller';
import {
  askedByLabel,
  competitorsOf,
  countsFrom,
  humanise,
  mapAlert,
  mapCandidate,
  mapFigures,
  mapFinding,
  mapQuestion,
  mapReport,
  mapWaitingRun,
  panelUrlOf,
} from './inbox.mapper';
import { InboxService } from './inbox.service';
import { McpToolError, McpTransportError, isUnknownTool } from './mcp.client';

const names = new Map([['saathi_report', 'Saathi Report']]);

function expectNoInternals(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(
    /dash:brain:|U0ABC1234|awaiting_clarification|pain_point|\bctr_pct\b/,
  );
}

describe('isUnknownTool', () => {
  it('recognises the shapes an MCP server uses for a tool it does not have', () => {
    expect(
      isUnknownTool(
        new McpToolError(
          'inbox_summary failed',
          'inbox_summary',
          '{"code":-32602,"message":"Tool inbox_summary not found"}',
        ),
      ),
    ).toBe(true);
    expect(
      isUnknownTool(
        new McpToolError(
          'x reported an error',
          'x',
          '[{"type":"text","text":"Unknown tool: x"}]',
        ),
      ),
    ).toBe(true);
    expect(
      isUnknownTool(
        new McpToolError(
          'x failed',
          'x',
          '{"code":-32601,"message":"Method not found"}',
        ),
      ),
    ).toBe(true);
  });
  it('does not treat a refusal or a dead server as "not available yet"', () => {
    expect(
      isUnknownTool(
        new McpToolError(
          'approval_record refused',
          'approval_record',
          'not authorised',
        ),
      ),
    ).toBe(false);
    expect(
      isUnknownTool(new McpTransportError('Could not reach brain', 'x')),
    ).toBe(false);
  });
});

describe('inbox mapper', () => {
  it('humanises unknown codes rather than passing them through', () => {
    expect(humanise('awaiting_clarification')).toBe('Awaiting clarification');
  });

  it('names who asked without showing a principal or a Slack id', () => {
    expect(askedByLabel('dash:brain:ujjwal', 'ujjwal')).toBe('You');
    expect(askedByLabel('dash:brain:priya', 'ujjwal')).toBe('Priya');
    expect(askedByLabel('brain_v2')).toBe('The Brain');
    expect(askedByLabel('U0ABC1234')).toBe('A teammate');
    expect(askedByLabel(null)).toBe('The Brain');
  });

  it('maps an open and an answered question', () => {
    const open = mapQuestion(
      {
        id: 7,
        question: 'Why did spend stop?',
        asked_by: 'dash:brain:ujjwal',
        surface: 'dashboard',
        status: 'open',
        kind: 'stall',
        created_at: '2026-09-28T04:00:00Z',
      },
      'ujjwal',
    );
    expect(open).toMatchObject({
      ref: '7',
      open: true,
      askedBy: 'You',
      kindLabel: 'Stalled campaign',
      statusLabel: 'Waiting for an answer',
    });
    const done = mapQuestion({
      id: 8,
      question: 'Plan?',
      status: 'answered',
      answer: 'Yes.',
      kind: 'plan_missing',
    });
    expect(done).toMatchObject({
      open: false,
      answer: 'Yes.',
      kindLabel: 'Missing plan',
      statusLabel: 'Answered',
    });
    expectNoInternals([open, done]);
  });

  it('maps an alert with a plain severity and source', () => {
    const a = mapAlert({
      id: 3,
      kind: 'credential',
      severity: 'critical',
      title: 'Meta token expires in 2 days',
      body: 'Renew it.',
      source: 'credential_health',
      created_at: '2026-09-28T04:00:00Z',
      acknowledged_at: null,
    });
    expect(a).toEqual({
      ref: '3',
      severity: 'critical',
      severityLabel: 'Urgent',
      title: 'Meta token expires in 2 days',
      body: 'Renew it.',
      sourceLabel: 'Account connections',
      raisedAt: '2026-09-28T04:00:00Z',
      acknowledged: false,
    });
    expect(mapAlert({ id: 4, title: 'x', severity: 'weird' })?.severity).toBe(
      'info',
    );
  });

  it('maps a report: kind, verdict, figures in rupees, panel link', () => {
    const r = mapReport(
      {
        id: 11,
        kind: 'daily_brief',
        report_date: '2026-09-27',
        headline: 'Spend on track',
        verdict: 'on_track',
        body: 'All good.',
        needs_attention: false,
        page_ref: 'reports/2026-09-27',
        figures: {
          spend_inr: 142000,
          roas: 2.456,
          ctr_pct: 1.234,
          purchases: 12,
          nested: { a: 1 },
        },
        delivered_at: '2026-09-27T03:00:00Z',
        read_at: null,
      },
      'https://panels.example.com/',
    );
    expect(r).toMatchObject({
      ref: '11',
      kind: 'daily_brief',
      kindLabel: 'Daily brief',
      verdictLabel: 'On track',
      verdictTone: 'good',
      panelUrl: 'https://panels.example.com/reports/2026-09-27',
      read: false,
    });
    expect(r!.figures).toEqual([
      { label: 'Spend', value: '₹1,42,000' },
      { label: 'Return on ad spend', value: '2.46x' },
      { label: 'Click rate', value: '1.23%' },
      { label: 'Sales', value: '12' },
    ]);
    expectNoInternals(r);
  });

  it('accepts figures as a list and panel refs as full URLs', () => {
    expect(mapFigures([{ label: 'Spend', key: 'spend', value: 500 }])).toEqual([
      { label: 'Spend', value: '₹500' },
    ]);
    expect(panelUrlOf('https://x.test/a', '')).toBe('https://x.test/a');
    expect(panelUrlOf('a/b', '')).toBeNull();
  });

  it('maps a waiting creative run and skips one with no question', () => {
    expect(
      mapWaitingRun({
        run_id: 'run_1',
        status: 'awaiting_clarification',
        clarification: { question: 'Which colour?' },
        offering_name: 'Saathi Report',
      }),
    ).toEqual({
      runRef: 'run_1',
      product: 'Saathi Report',
      question: 'Which colour?',
      since: null,
    });
    expect(
      mapWaitingRun({ run_id: 'run_2', status: 'awaiting_clarification' }),
    ).toBeNull();
    expect(
      mapWaitingRun({ run_id: 'run_3', status: 'running', question: 'x' }),
    ).toBeNull();
  });

  it('prefers the brain counts, falls back to list lengths, and totals', () => {
    const fb = { gates: 1, questions: 2, reports: 3, alerts: 4, waiting: 5 };
    expect(
      countsFrom(
        {
          gates_pending: 2,
          questions_open: 0,
          reports_unread: 1,
          alerts_open: 1,
        },
        fb,
      ),
    ).toEqual({
      gates: 2,
      questions: 0,
      reports: 1,
      alerts: 1,
      waiting: 5,
      total: 9,
      known: true,
    });
    expect(countsFrom(null, fb)).toMatchObject({ total: 15, known: false });
  });

  it('maps competitors, findings and candidates in words', () => {
    const list = competitorsOf(
      {
        competitors: [
          {
            name: 'AstroTalk',
            website: 'https://astrotalk.com',
            facebook_page: 'astrotalk',
            products: ['saathi_report'],
          },
          { website: 'no name' },
        ],
      },
      names,
    );
    expect(list).toEqual([
      {
        name: 'AstroTalk',
        website: 'https://astrotalk.com',
        facebookPage: 'astrotalk',
        products: [{ key: 'saathi_report', name: 'Saathi Report' }],
      },
    ]);
    const f = mapFinding({
      id: 5,
      competitor: 'AstroTalk',
      kind: 'ad',
      headline: 'Talk now',
      hook: 'Worried about marriage?',
      angle: 'pain_point',
      offer: '₹1 first chat',
      cta: 'LEARN_MORE',
      media_url: 'https://cdn.test/a.jpg',
      url: 'javascript:alert(1)',
      long_running: true,
    });
    expect(f).toMatchObject({
      ref: '5',
      kindLabel: 'Ad',
      angle: 'pain point',
      cta: 'learn more',
      imageUrl: 'https://cdn.test/a.jpg',
      link: null,
      longRunning: true,
    });
    const c = mapCandidate(
      {
        id: 9,
        statement: 'Marriage-worry hooks pull clicks',
        offering_slug: 'saathi_report',
        detail: { competitor: 'AstroTalk' },
        evidence_summary: 'Seen in 4 ads over 30 days',
      },
      names,
    );
    expect(c).toMatchObject({
      ref: '9',
      claim: 'Marriage-worry hooks pull clicks',
      product: 'Saathi Report',
      competitor: 'AstroTalk',
      evidence: 'Seen in 4 ads over 30 days',
    });
    expectNoInternals([list, f, c]);
  });
});

/* ── Service: tolerant of tools the brain does not have yet ───────────────── */

function service(
  respond: (tool: string, args: Record<string, unknown>) => unknown,
) {
  const config = new ConfigService({
    brain: { url: 'http://brain', token: 't', panelsBaseUrl: '' },
    foundry: { url: 'http://f', token: 'f' },
  });
  const bridge = {
    getGates: jest.fn().mockResolvedValue([]),
    productNames: jest.fn().mockResolvedValue(names),
  };
  const pipeline = { listWaitingRuns: jest.fn().mockResolvedValue(null) };
  const svc = new InboxService(config, bridge as never, pipeline as never);
  const call = jest.fn(
    async (tool: string, args: Record<string, unknown> = {}) =>
      respond(tool, args),
  );
  (svc as unknown as { brain: unknown }).brain = {
    isConfigured: () => true,
    call,
  };
  const foundryCall = jest.fn().mockResolvedValue({ run_id: 'run_x' });
  (svc as unknown as { foundry: unknown }).foundry = {
    isConfigured: () => true,
    call: foundryCall,
  };
  return { svc, call, bridge, pipeline, foundryCall };
}

const unknown = (tool: string) =>
  new McpToolError(`${tool} failed`, tool, `Unknown tool: ${tool}`);

describe('InboxService', () => {
  it('builds the inbox with every new section "not available yet" before the brain deploys', async () => {
    const { svc } = service((tool) => {
      throw unknown(tool);
    });
    const inbox = await svc.getInbox('ujjwal');
    expect(inbox.availability).toEqual({
      gates: 'ok',
      questions: 'not_available_yet',
      alerts: 'not_available_yet',
      reports: 'not_available_yet',
      waiting: 'not_available_yet',
    });
    expect(inbox.counts).toMatchObject({ total: 0, known: false });
  });

  it('says could_not_load (not "not available yet") when the brain is down', async () => {
    const { svc } = service((tool) => {
      throw new McpTransportError('Could not reach brain', tool);
    });
    const inbox = await svc.getInbox(null);
    expect(inbox.availability.alerts).toBe('could_not_load');
  });

  it('reads the inbox from the brain tools', async () => {
    const { svc, call } = service((tool) => {
      if (tool === 'inbox_summary')
        return {
          gates_pending: 0,
          questions_open: 1,
          reports_unread: 1,
          alerts_open: 1,
        };
      if (tool === 'questions_list')
        return { rows: [{ id: 1, question: 'Q?', status: 'open' }] };
      if (tool === 'alerts_list')
        return { rows: [{ id: 2, title: 'A', severity: 'warn' }] };
      if (tool === 'reports_list')
        return { rows: [{ id: 3, kind: 'monitor', headline: 'H' }] };
      throw unknown(tool);
    });
    const inbox = await svc.getInbox(null);
    expect(inbox.counts).toMatchObject({
      questions: 1,
      reports: 1,
      alerts: 1,
      total: 3,
      known: true,
    });
    expect(inbox.reports[0].kindLabel).toBe('Spend watch');
    expect(call).toHaveBeenCalledWith('reports_list', {
      unread_only: true,
      limit: 20,
    });
    expect(call).toHaveBeenCalledWith('alerts_list', {
      open_only: true,
      limit: 50,
    });
  });

  it('pages reports by over-reading one row', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      kind: 'performance',
      headline: `R${i}`,
    }));
    const { svc, call } = service(() => ({ rows }));
    const p2 = await svc.getReports('performance', 2);
    expect(call).toHaveBeenCalledWith('reports_list', {
      kind: 'performance',
      since_days: 90,
      limit: 41,
    });
    expect(p2).toMatchObject({ state: 'ok', page: 2, hasMore: false });
    expect(p2.reports).toHaveLength(5);
    expect(p2.kinds).toEqual([
      { key: 'performance', label: 'Performance report' },
    ]);
  });

  it('turns a write against a missing tool into a plain 501', async () => {
    const { svc } = service((tool) => {
      throw unknown(tool);
    });
    await expect(svc.ackAlert('3', 'dash:brain:u')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    await expect(svc.ackAlert('3', 'dash:brain:u')).rejects.toThrow(
      /isn't available yet/,
    );
  });

  it('records writes under the principal with numeric ids', async () => {
    const { svc, call } = service(() => ({ ok: true }));
    await svc.markReportRead('11', 'dash:brain:u');
    await svc.askQuestion('  Why?  ', 'dash:brain:u');
    await svc.decideCandidate('9', 'accept', 'Seen everywhere', 'dash:brain:u');
    expect(call).toHaveBeenCalledWith('report_mark_read', {
      id: 11,
      principal: 'dash:brain:u',
    });
    expect(call).toHaveBeenCalledWith('question_ask', {
      text: 'Why?',
      principal: 'dash:brain:u',
    });
    expect(call).toHaveBeenCalledWith('competitor_candidate_decide', {
      id: 9,
      decision: 'accept',
      principal: 'dash:brain:u',
      reason: 'Seen everywhere',
    });
  });

  it('requires a reason to decide a candidate and refuses duplicate competitors', async () => {
    const { svc } = service(() => ({ ok: true }));
    await expect(
      svc.decideCandidate('9', 'reject', '  ', 'p'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.saveCompetitors([{ name: 'A' }, { name: 'a' }]),
    ).rejects.toThrow(/listed twice/);
  });

  it('saves competitors in the brain shape and reads them back', async () => {
    const { svc, call } = service((tool, args) =>
      tool === 'competitors_read'
        ? { competitors: [{ name: 'A', products: ['saathi_report'] }] }
        : args,
    );
    const out = await svc.saveCompetitors([
      {
        name: ' A ',
        website: '',
        facebookPage: 'a.page',
        products: ['saathi_report'],
      },
    ]);
    expect(call).toHaveBeenCalledWith('competitors_write', {
      competitors: [
        {
          name: 'A',
          website: null,
          facebook_page: 'a.page',
          products: ['saathi_report'],
        },
      ],
    });
    expect(out.competitors[0].products).toEqual([
      { key: 'saathi_report', name: 'Saathi Report' },
    ]);
    expect(out.products).toEqual([
      { key: 'saathi_report', name: 'Saathi Report' },
    ]);
  });

  it('starts Competitor Research with no inputs', async () => {
    const { svc, foundryCall } = service(() => ({}));
    await expect(svc.runCompetitorResearch()).resolves.toEqual({
      runId: 'run_x',
    });
    expect(foundryCall).toHaveBeenCalledWith(
      'run_agent',
      expect.objectContaining({ inputs: {}, wait_seconds: 0 }),
    );
  });
});

/* ── Controller ───────────────────────────────────────────────────────────── */

describe('InboxController', () => {
  const inbox = {
    getInbox: jest.fn().mockResolvedValue({}),
    getReports: jest.fn().mockResolvedValue({}),
    markReportRead: jest.fn().mockResolvedValue({ ok: true }),
    askQuestion: jest.fn().mockResolvedValue({ ok: true }),
    ackAlert: jest.fn().mockResolvedValue({ ok: true }),
    decideCandidate: jest.fn().mockResolvedValue({ ok: true }),
  };
  const ctrl = new InboxController(inbox as never);
  const req = { user: { sub: 'ujjwal', role: 'brain' as const } } as never;

  it('is brain-login only', () => {
    expect(new Reflector().get(ROLES_KEY, InboxController)).toEqual(['brain']);
  });

  it('passes the brain principal on every write', async () => {
    await ctrl.markRead('t', '11', req);
    await ctrl.ask('t', { text: 'Why?' }, req);
    await ctrl.ack('t', '3', req);
    await ctrl.decide('t', '9', { decision: 'reject', reason: 'No' }, req);
    expect(inbox.markReportRead).toHaveBeenCalledWith(
      '11',
      'dash:brain:ujjwal',
    );
    expect(inbox.askQuestion).toHaveBeenCalledWith('Why?', 'dash:brain:ujjwal');
    expect(inbox.ackAlert).toHaveBeenCalledWith('3', 'dash:brain:ujjwal');
    expect(inbox.decideCandidate).toHaveBeenCalledWith(
      '9',
      'reject',
      'No',
      'dash:brain:ujjwal',
    );
  });

  it('sanitises the report filter and page', async () => {
    await ctrl.reports('t', 'daily_brief', '2');
    await ctrl.reports('t', "x'; drop", 'abc');
    expect(inbox.getReports).toHaveBeenNthCalledWith(1, 'daily_brief', 2);
    expect(inbox.getReports).toHaveBeenNthCalledWith(2, null, 1);
  });

  it('gives the inbox the viewer so their own questions read "You"', async () => {
    await ctrl.getInbox('t', req);
    expect(inbox.getInbox).toHaveBeenCalledWith('ujjwal');
  });
});
