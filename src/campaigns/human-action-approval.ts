/** Execution status is not authorization: legacy automatic actions used "executed" too. */
export function hasHumanActionApproval(
  action:
    | {
        status?: string;
        humanApprovedAt?: Date | string;
        autoApplied?: boolean;
      }
    | null
    | undefined,
): boolean {
  return (
    action?.status === 'executed' &&
    action.autoApplied !== true &&
    !!action.humanApprovedAt &&
    Number.isFinite(new Date(action.humanApprovedAt).getTime())
  );
}
