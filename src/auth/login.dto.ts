import { IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

/**
 * POST /api/v1/auth/login body. Two credential sets share this route:
 * - workspace: `{ email, password }` (AUTH_EMAIL / AUTH_PASSWORD)
 * - brain:     `{ username, password }` (BRAIN_AUTH_USERNAME / BRAIN_AUTH_PASSWORD)
 * Either identifier field is accepted for either set — the server decides the
 * role by which pair matched, never by which field was sent.
 */
export class LoginDto {
  @ValidateIf((o: LoginDto) => !o.username)
  @IsString()
  @MinLength(1)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  username?: string;

  @IsString()
  @MinLength(1)
  password: string;
}
