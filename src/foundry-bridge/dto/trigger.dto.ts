import { IsBoolean } from 'class-validator';

/**
 * The only change the console may make to a schedule.
 *
 * No cron, no name, no kind. Turning a known schedule back on is recovering from a visible
 * mistake; changing when something runs is a decision about how the company operates, and that
 * stays in Studio where it can be reviewed.
 */
export class SetTriggerEnabledDto {
  @IsBoolean()
  enabled: boolean;
}
