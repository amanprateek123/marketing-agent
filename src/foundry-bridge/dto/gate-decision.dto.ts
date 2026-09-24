import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** One human answer to one gate. Mirrors `BrainGateDecisionBody` on the console side. */
export class GateDecisionDto {
  @IsIn(['approve', 'reject', 'revise'])
  action: 'approve' | 'reject' | 'revise';

  /**
   * Their words, kept for the audit trail.
   *
   * A rejection's note is the only thing that tells the next run what to change, so the console
   * requires one there. It is optional at this layer because the brain's own tools accept an empty
   * one, and a rule enforced in two places drifts in one of them.
   */
  @IsOptional()
  @IsString()
  note?: string;

  /** Which items were picked, for a gate whose selection is `single` or `multiple`. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedIds?: string[];

  /**
   * "Approve, but at this daily amount" — the console's equivalent of Slack's `approve at <n>`.
   *
   * Declared here because ValidationPipe({ whitelist: true }) STRIPS an undeclared body property
   * silently: the field would arrive, vanish before the handler, and the decision would record the
   * proposed amount while the operator believed they had changed it.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  amountOverrideInr?: number;
}
