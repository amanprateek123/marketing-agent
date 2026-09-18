import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCampaignCopilotSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientMessageId?: string;
}

export class SendCampaignCopilotMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  message: string;

  /** Optional browser-generated idempotency key for retries/double clicks. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientMessageId?: string;
}
