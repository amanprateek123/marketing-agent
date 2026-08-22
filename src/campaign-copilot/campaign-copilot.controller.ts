import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CampaignCopilotService } from './campaign-copilot.service';
import {
  CreateCampaignCopilotSessionDto,
  SendCampaignCopilotMessageDto,
} from './dto/campaign-copilot.dto';

@Controller('campaign-copilot/:tenantId')
export class CampaignCopilotController {
  constructor(private readonly campaignCopilot: CampaignCopilotService) {}

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
