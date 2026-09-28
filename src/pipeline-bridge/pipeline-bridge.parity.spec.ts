import {
  BadRequestException,
  HttpException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/roles';
import {
  CampaignFieldsDto,
  LearnDecisionDto,
  ResearchSourcesDto,
} from './dto/parity.dto';
import { PipelineBridgeController } from './pipeline-bridge.controller';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * Creative-studio parity: every action Slack buttons used to be the only door to, proxied to the
 * creativebot route of the same shape (contract §2). These pin the exact method + path + body the
 * bridge sends, because creativebot is built in parallel against that same contract and a drifted
 * path is a silent 404 that the dashboard shows as "not available yet".
 */
describe('PipelineBridgeService — creative parity proxies', () => {
  const config = {
    get: (key: string) =>
      (
        ({
          'pipeline.url': 'https://pipeline.example.com/',
          'pipeline.token': 't',
          'pipeline.timeoutMs': 1000,
        }) as Record<string, unknown>
      )[key],
  } as unknown as ConfigService;

  let service: PipelineBridgeService;
  let request: jest.Mock;

  beforeEach(() => {
    service = new PipelineBridgeService(config);
    request = jest.fn().mockResolvedValue({
      data: { ok: true, status: 'queued', message: 'Done' },
    });
    (service as unknown as { http: { request: jest.Mock } }).http = { request };
  });

  const sent = () =>
    request.mock.calls[0][0] as { method: string; url: string; data?: unknown };
  const base = 'https://pipeline.example.com/v1';

  const cases: Array<
    [string, () => Promise<unknown>, string, string, unknown]
  > = [
    [
      'cancel',
      () => service.cancelRun('41'),
      'post',
      '/runs/41/cancel',
      undefined,
    ],
    [
      'retry',
      () => service.retryRun('41'),
      'post',
      '/runs/41/retry',
      undefined,
    ],
    ['retry full', () => service.retryRun('41', 'full'), 'post', '/runs/41/retry', { step: 'full' }],
    [
      'model + quality',
      () => service.setModel('41', 'gpt-image-2', 'medium'),
      'post',
      '/runs/41/model',
      { model: 'gpt-image-2', quality: 'medium' },
    ],
    [
      'logo + disclaimer',
      () => service.setLogo('41', true, 'tnc'),
      'post',
      '/runs/41/logo',
      { include: true, disclaimer: 'tnc' },
    ],
    [
      'run anyway',
      () => service.runAnyway('41'),
      'post',
      '/runs/41/run-anyway',
      undefined,
    ],
    [
      'model',
      () => service.setModel('41', 'gpt-image'),
      'post',
      '/runs/41/model',
      { model: 'gpt-image' },
    ],
    [
      'approve preview',
      () => service.approveRun('41', 'preview'),
      'post',
      '/runs/41/approve',
      { stage: 'preview' },
    ],
    [
      'approve full',
      () => service.approveRun('41', 'full'),
      'post',
      '/runs/41/approve',
      { stage: 'full' },
    ],
    [
      'generate copy',
      () => service.generateCampaignFields('41'),
      'post',
      '/runs/41/campaign-fields',
      undefined,
    ],
    [
      'edit copy',
      () => service.editCampaignFields('41', { headline: 'H' }),
      'put',
      '/runs/41/campaign-fields',
      { headline: 'H' },
    ],
    [
      'approve copy',
      () => service.approveCampaignFields('41'),
      'post',
      '/runs/41/campaign-fields/approve',
      undefined,
    ],
    [
      'badge',
      () => service.setBadge('41', 'up_1'),
      'post',
      '/runs/41/badge',
      { upload_id: 'up_1' },
    ],
    [
      'logo',
      () => service.setLogo('41', false),
      'post',
      '/runs/41/logo',
      { include: false },
    ],
    [
      'discard idea',
      () => service.discardIdea('7', 'off brand'),
      'post',
      '/ideas/7/discard',
      { reason: 'off brand' },
    ],
    [
      'sources',
      () => service.getResearchSources('9'),
      'get',
      '/research/9/sources',
      undefined,
    ],
    [
      'confirm sources',
      () => service.confirmResearchSources('9', true),
      'post',
      '/research/9/sources',
      { confirm: true },
    ],
    [
      'override sources',
      () => service.confirmResearchSources('9', false, ['https://a.example']),
      'post',
      '/research/9/sources',
      { confirm: false, urls: ['https://a.example'] },
    ],
    [
      'reuse',
      () => service.rerunResearch('9', 'reuse'),
      'post',
      '/research/9/rerun',
      { choice: 'reuse' },
    ],
    [
      'directions',
      () => service.getResearchDirections('9'),
      'get',
      '/research/9/directions',
      undefined,
    ],
    [
      'build',
      () => service.buildDirection('9', '2'),
      'post',
      '/research/9/directions/2/build',
      undefined,
    ],
    [
      'expand',
      () => service.expandConcept('9', '2'),
      'post',
      '/research/9/directions/2/expand',
      undefined,
    ],
    [
      'pdf',
      () => service.researchFromPdf('up_2', 'nadi'),
      'post',
      '/research/pdf',
      { upload_id: 'up_2', product: 'nadi' },
    ],
    [
      'proposals',
      () => service.getLearnProposals(),
      'get',
      '/learn/proposals',
      undefined,
    ],
    [
      'decide proposal',
      () =>
        service.decideLearnProposal('3', {
          decision: 'approve',
          decided_by: 'dash:brain:u',
        }),
      'post',
      '/learn/proposals/3',
      { decision: 'approve', decided_by: 'dash:brain:u' },
    ],
  ];

  it.each(cases)('%s → %s %s', async (_n, call, method, path, body) => {
    await expect(call()).resolves.toEqual({
      ok: true,
      status: 'queued',
      message: 'Done',
    });
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${base}${path}`);
    expect(sent().data).toEqual(body);
  });

  it('encodes ids so a slash cannot reach another route', async () => {
    await service.cancelRun('4/../1');
    expect(sent().url).toBe(`${base}/runs/4%2F..%2F1/cancel`);
  });

  const reject = (status: number, data: unknown) =>
    request.mockRejectedValueOnce({
      response: { status, data },
      message: `Request failed with status code ${status}`,
    });

  it('a route creativebot has not shipped yet reads as "not available yet", keeping the 404', async () => {
    reject(404, { detail: 'Not Found' });
    const err = await service.cancelRun('41').catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toBe('This is not available yet.');
  });

  it("shows creativebot's message when it fails with { ok: false, message }", async () => {
    reject(409, { ok: false, message: 'The model can only be changed while the layout waits.' });
    const err = (await service.setModel('41', 'gpt-image-2').catch((e) => e)) as HttpException;
    expect(err.message).toBe('The model can only be changed while the layout waits.');
  });

  it("passes creativebot's own plain refusal through with its status", async () => {
    reject(409, { error: 'This run already finished.' });
    const err = (await service.retryRun('41').catch((e) => e)) as HttpException;
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe('This run already finished.');
  });

  it('never shows axios wording for a refusal without a reason', async () => {
    reject(422, {});
    const err = (await service
      .setLogo('41', true)
      .catch((e) => e)) as HttpException;
    expect(err.message).not.toMatch(/status code/);
  });
});

describe('PipelineBridgeController — parity guards', () => {
  const bridge = {
    editCampaignFields: jest.fn().mockResolvedValue({ ok: true }),
    expandConcept: jest.fn().mockResolvedValue({ ok: true }),
    decideLearnProposal: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PipelineBridgeService;
  const controller = new PipelineBridgeController(bridge);
  const reflector = new Reflector();

  it('learnings proposals are Brain-login only; creative actions keep the workspace login', () => {
    const proto = PipelineBridgeController.prototype;
    expect(reflector.get(ROLES_KEY, proto.getLearnProposals)).toEqual([
      'brain',
    ]);
    expect(reflector.get(ROLES_KEY, proto.decideLearnProposal)).toEqual([
      'brain',
    ]);
    expect(reflector.get(ROLES_KEY, proto.cancelRun)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, PipelineBridgeController)).toBeUndefined();
  });

  it('records the decision under the Brain principal', async () => {
    await controller.decideLearnProposal(
      '3',
      { decision: 'reject' } as LearnDecisionDto,
      {
        user: { sub: 'owner', role: 'brain' },
      } as never,
    );
    expect(bridge.decideLearnProposal).toHaveBeenCalledWith('3', {
      decision: 'reject',
      decided_by: 'dash:brain:owner',
    });
  });

  it('an edit without the corrected text is refused in plain words', async () => {
    await expect(
      controller.decideLearnProposal(
        '3',
        { decision: 'edit', text: '  ' } as LearnDecisionDto,
        {
          user: { sub: 'owner', role: 'brain' },
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('expand takes a concept index, never a direction id', () => {
    expect(() => controller.expandConcept('9', 'dir-7')).toThrow(BadRequestException);
  });

  it('saving ad copy with nothing changed is refused', async () => {
    await expect(
      controller.editCampaignFields('41', {} as CampaignFieldsDto),
    ).rejects.toThrow(/at least one field/);
  });

  it('only forwards the ad-copy fields that were sent', async () => {
    await controller.editCampaignFields('41', {
      cta: 'Book now',
    } as CampaignFieldsDto);
    expect(bridge.editCampaignFields).toHaveBeenCalledWith('41', {
      cta: 'Book now',
    });
  });
});

describe('parity DTOs survive the whitelist', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });

  it('source overrides keep their urls', async () => {
    const out = (await pipe.transform(
      { confirm: false, urls: ['https://a.example'] },
      { type: 'body', metatype: ResearchSourcesDto },
    )) as ResearchSourcesDto;
    expect(out.urls).toEqual(['https://a.example']);
  });

  it('ad-copy edits keep every field', async () => {
    const body = {
      headline: 'h',
      primary_text: 'p',
      description: 'd',
      cta: 'c',
    };
    const out = await pipe.transform(body, {
      type: 'body',
      metatype: CampaignFieldsDto,
    });
    expect(out).toEqual(body);
  });

  it('an unknown learning decision is refused', async () => {
    await expect(
      pipe.transform(
        { decision: 'maybe' },
        { type: 'body', metatype: LearnDecisionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
