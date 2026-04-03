import { Injectable, Logger } from '@nestjs/common';

/**
 * Handles fallback logic when an agent team fails.
 * The actual fallback execution (e.g. running single-agent scouts)
 * is done by the PipelineOrchestratorService — this service just
 * provides the decision logic and logging.
 */
@Injectable()
export class TeamFallbackService {
  private readonly logger = new Logger(TeamFallbackService.name);

  /**
   * Determine if a team failure should trigger fallback to single-agent mode.
   * Returns true if fallback should be used.
   */
  shouldFallback(error: Error, teamName: string): boolean {
    const isTimeout = error.message.includes('timeout') || error.message.includes('TIMEOUT');
    const isParseError = error.message.includes('invalid JSON') || error.message.includes('Invalid JSON');
    const isTeamError = error.message.includes('TeamCreate') || error.message.includes('SendMessage');

    if (isTimeout || isParseError || isTeamError) {
      this.logger.warn(
        `Team "${teamName}" failed with recoverable error — recommending fallback | error: ${error.message}`,
      );
      return true;
    }

    // Non-recoverable errors (rate limit, auth, etc.) — don't waste tokens retrying
    this.logger.error(
      `Team "${teamName}" failed with non-recoverable error — no fallback | error: ${error.message}`,
    );
    return false;
  }
}
