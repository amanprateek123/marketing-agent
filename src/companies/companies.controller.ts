import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { PromptGeneratorService } from './prompt-generator/prompt-generator.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Controller('companies')
export class CompaniesController {
  private readonly logger = new Logger(CompaniesController.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly promptGenerator: PromptGeneratorService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateCompanyDto) {
    const company = await this.companiesService.create(dto);

    // Fire and forget — don't block the response
    this.promptGenerator.generate(company.tenantId).catch((err) =>
      this.logger.error(`Prompt generation failed for ${company.tenantId}: ${err.message}`),
    );

    return {
      tenantId: company.tenantId,
      apiKey: company.apiKey,
      message: 'Company created. Generating 9 agent prompts in background.',
    };
  }

  @Get()
  findAll() {
    return this.companiesService.findAll();
  }

  @Get(':tenantId')
  findOne(@Param('tenantId') tenantId: string) {
    return this.companiesService.findByTenantId(tenantId);
  }

  @Put(':tenantId')
  async update(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    const { company, needsPromptRegen } = await this.companiesService.update(tenantId, dto);

    if (needsPromptRegen) {
      // Fire and forget
      this.promptGenerator.generate(tenantId).catch((err) =>
        this.logger.error(`Prompt regeneration failed for ${tenantId}: ${err.message}`),
      );
    }

    return {
      tenantId: company.tenantId,
      promptRegenTriggered: needsPromptRegen,
      message: needsPromptRegen
        ? 'Company updated. Regenerating agent prompts in background.'
        : 'Company updated.',
    };
  }

  @Post(':tenantId/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  async regenerate(@Param('tenantId') tenantId: string) {
    // Verify company exists before triggering
    await this.companiesService.findByTenantId(tenantId);

    this.promptGenerator.generate(tenantId).catch((err) =>
      this.logger.error(`Manual prompt regeneration failed for ${tenantId}: ${err.message}`),
    );

    return { tenantId, message: 'Prompt regeneration started.' };
  }
}
