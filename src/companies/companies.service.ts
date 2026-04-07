import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Company, CompanyDocument } from './schemas/company.schema';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { CompanyPrompts, CompanyLearnings } from './schemas/company.types';

// Fields that require prompt regeneration when changed
const PROMPT_RELEVANT_FIELDS: (keyof UpdateCompanyDto)[] = [
  'tone',
  'targetAudience',
  'audiencePersonas',
  'competitors',
  'brandGuidelines',
  'products',
  'services',
  'uniqueValue',
  'industry',
];

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    @InjectModel(Company.name)
    private readonly companyModel: Model<CompanyDocument>,
  ) {}

  async create(dto: CreateCompanyDto): Promise<CompanyDocument> {
    const existing = await this.companyModel.findOne({ tenantId: dto.tenantId });
    if (existing) {
      throw new ConflictException(`Company with tenantId "${dto.tenantId}" already exists`);
    }

    const company = await this.companyModel.create({
      ...dto,
      apiKey: uuidv4(),
      prompts: null,
      learnings: null,
    });

    this.logger.log(`Created company: ${company.tenantId}`);
    return company;
  }

  async findAll(): Promise<CompanyDocument[]> {
    // Exclude prompts and learnings from list view
    return this.companyModel
      .find()
      .select('-prompts -learnings')
      .lean()
      .exec() as unknown as CompanyDocument[];
  }

  async findByTenantId(tenantId: string): Promise<CompanyDocument> {
    const company = await this.companyModel.findOne({ tenantId }).exec();
    if (!company) {
      throw new NotFoundException(`Company "${tenantId}" not found`);
    }
    return company;
  }

  async update(
    tenantId: string,
    dto: UpdateCompanyDto,
  ): Promise<{ company: CompanyDocument; needsPromptRegen: boolean }> {
    const company = await this.findByTenantId(tenantId);

    const needsPromptRegen = PROMPT_RELEVANT_FIELDS.some(
      (field) => field in dto,
    );

    const { meta, ...rest } = dto as any;
    Object.assign(company, rest);

    // Merge meta fields instead of replacing — prevents wiping accessToken when only updating pixelId
    if (meta) {
      company.meta = { ...(company.meta ?? {}), ...meta } as any;
    }

    await company.save();

    this.logger.log(
      `Updated company: ${tenantId} | promptRegen: ${needsPromptRegen}`,
    );

    return { company, needsPromptRegen };
  }

  async updatePrompts(tenantId: string, prompts: CompanyPrompts): Promise<void> {
    await this.companyModel.updateOne({ tenantId }, { $set: { prompts } });
    this.logger.log(`Prompts updated for: ${tenantId}`);
  }

  async updateLearnings(tenantId: string, learnings: CompanyLearnings): Promise<void> {
    await this.companyModel.updateOne({ tenantId }, { $set: { learnings } });
    this.logger.log(`Learnings updated for: ${tenantId} (v${learnings.version})`);
  }

  async findByApiKey(apiKey: string): Promise<CompanyDocument | null> {
    return this.companyModel.findOne({ apiKey }).exec();
  }
}
