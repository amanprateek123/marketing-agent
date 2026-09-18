/**
 * The name Meta will actually receive for a campaign.
 *
 * Extracted so the approval preview shows the SAME string launch() sends. A
 * preview that renders the stored `campaign.name` while Meta gets a
 * date-suffixed variant is exactly the kind of drift that makes an approval
 * screen untrustworthy — and the duplicate-name idempotency guard keys off
 * this value, so the operator needs to see the real one before approving.
 */
export function buildMetaCampaignName(
  campaign: { name?: string; topic?: string },
  now: Date = new Date(),
): string {
  const dateSuffix = now.toISOString().split('T')[0];
  // Prefer the human-given campaign name (manual campaigns always have a
  // distinct one) over the topic-based scheme. The topic scheme collapses to
  // "AGENT_CAMPAIGN_<date>" for every manual campaign launched the same day
  // (manual campaigns have no `topic`), so two unrelated campaigns launched on
  // the same date collide on the SAME Meta campaign name — the duplicate-launch
  // idempotency guard then refuses the second one, reading it as a retry of the
  // first. Hit in production 2026-07-16: a small test campaign's successful
  // launch blocked the real campaign's launch right after. AI-pipeline
  // campaigns keep the old topic-based name (their `name` field isn't reliably
  // set), unchanged.
  const humanName = (campaign.name ?? '').trim();
  if (humanName) return `${humanName}_${dateSuffix}`;
  const topicSlug = (campaign.topic ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 30);
  return `AGENT_${topicSlug || 'CAMPAIGN'}_${dateSuffix}`;
}
