import {
  IsString,
  IsNumber,
  IsArray,
  IsOptional,
  IsEnum,
  IsObject,
  ValidateNested,
  IsBoolean,
  Min,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

class ProductDto {
  @IsString() @IsNotEmpty() name: string;
  @IsNumber() @Min(0) price: number;
  @IsString() @IsNotEmpty() currency: string;
  @IsString() description: string;
  @IsBoolean() active: boolean;

  // Marketing data
  @IsOptional() @IsString() landingUrl?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) languages?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) trendKeywords?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) differentiators?: string[];

  // Conversion tracking
  @IsOptional() @IsString() conversionEvent?: string;
  @IsOptional() @IsNumber() @Min(0) conversionValue?: number;
  @IsOptional() @IsString() customEventName?: string;
  @IsOptional() @IsString() customConversionId?: string;
  @IsOptional() @IsString() pixelId?: string;
}

class ServiceDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() description: string;
  @IsBoolean() active: boolean;
}

class DeliveryDto {
  @IsOptional() @IsString() slackWebhook?: string;
  @IsOptional() @IsString() whatsappNumber?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() notionDatabaseId?: string;
}

class MetaDto {
  @IsOptional() @IsString() accessToken?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) accountIds?: string[];
  @IsOptional() @IsString() pixelId?: string;
  @IsOptional() @IsString() pageId?: string;
}

export class CreateCompanyDto {
  @IsString() @IsNotEmpty()
  tenantId: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  industry: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ProductDto)
  products?: ProductDto[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ServiceDto)
  services?: ServiceDto[];

  @IsString() @IsNotEmpty()
  targetAudience: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  audiencePersonas?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  customerLanguage?: string[];

  @IsString() @IsNotEmpty()
  tone: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  avoid?: string[];

  @IsString() @IsNotEmpty()
  uniqueValue: string;

  @IsOptional() @IsString()
  brandGuidelines?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  competitors?: string[];

  @IsOptional() @IsString()
  competitorNotes?: string;

  @IsOptional() @IsString()
  calendarContext?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  platforms?: string[];

  @IsString() @IsNotEmpty()
  geography: string;

  @IsString() @IsNotEmpty()
  language: string;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => DeliveryDto)
  delivery?: DeliveryDto;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => MetaDto)
  meta?: MetaDto;

  // Marketing Requirements
  @IsNumber() @Min(0)
  weeklyBudgetCap: number;

  @IsNumber() @Min(0)
  maxBudgetPerCampaign: number;

  @IsOptional() @IsNumber() @Min(0)
  maxBudgetScalePercent?: number;

  @IsEnum(['conversions', 'awareness', 'traffic', 'leads'])
  primaryObjective: string;

  @IsOptional() @IsNumber() targetROAS?: number;
  @IsOptional() @IsNumber() targetCPA?: number;
  @IsOptional() @IsNumber() pauseIfROASBelow?: number;
  @IsOptional() @IsNumber() pauseIfCTRBelow?: number;
  @IsOptional() @IsNumber() pauseIfFrequencyAbove?: number;
  @IsOptional() @IsNumber() pauseAfterDaysInLearning?: number;
  @IsOptional() @IsNumber() scaleIfROASAbove?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  forbiddenTopics?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  preferredFormats?: string[];

  @IsOptional() @IsNumber() @Min(1)
  campaignsPerRun?: number;

  @IsOptional() @IsEnum(['weekly', 'biweekly'])
  runFrequency?: string;

  @IsOptional() @IsObject()
  pipelineConfig?: {
    mode?: 'daily' | 'weekly';
    ideasPerRun?: number;
    autoSwitch?: boolean;
    coldStartDays?: number;
  };
}
