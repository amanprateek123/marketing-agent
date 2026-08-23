import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CampaignCopilotService } from './campaign-copilot.service';
import { CampaignInsightsService } from './campaign-insights.service';
import {
  CreateCampaignCopilotSessionDto,
  SendCampaignCopilotMessageDto,
} from './dto/campaign-copilot.dto';

@Controller('campaign-copilot/:tenantId')
export class CampaignCopilotController {
  constructor(
    private readonly campaignCopilot: CampaignCopilotService,
    private readonly campaignInsights: CampaignInsightsService,
  ) {}

  /**
   * Queries mode — ask about campaigns that already ran. Deliberately
   * stateless: the planner's session machinery stays untouched, and the
   * client keeps the transcript.
   */
  @Get('insights/campaigns')
  listInsightCampaigns(@Param('tenantId') tenantId: string) {
    return this.campaignInsights.listCampaigns(tenantId);
  }

  @Post('insights/ask')
  askInsights(
    @Param('tenantId') tenantId: string,
    @Body()
    dto: {
      question: string;
      campaignId?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ) {
    return this.campaignInsights.ask(tenantId, dto.question, {
      campaignId: dto.campaignId,
      history: dto.history,
    });
  }

  @Post('sessions')
  createSession(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateCampaignCopilotSessionDto,
  ) {
    return this.campaignCopilot.createSession(
      tenantId,
      dto.message,
      dto.clientMessageId,
    );
  }

  @Get('sessions/:sessionId')
  getSession(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.campaignCopilot.getSession(tenantId, sessionId);
  }

  @Post('sessions/:sessionId/messages')
  sendMessage(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: SendCampaignCopilotMessageDto,
  ) {
    return this.campaignCopilot.sendMessage(
      tenantId,
      sessionId,
      dto.message,
      dto.clientMessageId,
    );
  }

  @Post('sessions/:sessionId/confirm')
  confirm(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.campaignCopilot.confirm(tenantId, sessionId);
  }
}
