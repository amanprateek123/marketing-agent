import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * One turn typed into the console.
 *
 * The session id is in the URL, not here: it identifies the thread being written to, which is a
 * property of the address rather than of the message.
 */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  /**
   * Usually left unset. The Brain picks its own mode from what is queued and what was asked, and
   * that choice is deterministic code rather than a guess — overriding it is an operator saying
   * "do this instead", not the normal path.
   */
  @IsOptional()
  @IsIn(['decide', 'sense', 'allocate', 'consolidate'])
  mode?: 'decide' | 'sense' | 'allocate' | 'consolidate';
}
