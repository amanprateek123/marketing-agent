import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateCompanyDto } from './create-company.dto';

// All fields optional, tenantId not updatable
export class UpdateCompanyDto extends PartialType(
  OmitType(CreateCompanyDto, ['tenantId'] as const),
) {}
