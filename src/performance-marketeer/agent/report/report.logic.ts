/**
 * Pure helpers for the campaign report (pm-report.service.ts). No I/O, so the
 * rules are unit-tested in report.logic.spec.ts.
 */

/** `## Heading` sections of a phase markdown file, front matter dropped. */
export function mdSections(md: string): { heading: string; body: string }[] {
  const text = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  return text
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      return {
        heading: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(),
        body: nl < 0 ? '' : chunk.slice(nl + 1).trim(),
      };
    });
}

/** The section whose heading starts with `prefix` (e.g. "Verdict", "C1"), or ''. */
export function sectionBody(
  sections: { heading: string; body: string }[],
  prefix: string,
) {
  const re = new RegExp(`^${prefix}(\\b|\\s|$)`, 'i');
  return sections.find((s) => re.test(s.heading))?.body ?? '';
}

/** Content of the highest round of a phase file, e.g. 01-investigate.v2.md. */
export function latestFile(
  files: Record<string, string>,
  stem: string,
  ext = '.md',
): string {
  let best = -1;
  let out = '';
  const re = new RegExp(
    `^${stem.replace(/[.]/g, '\\.')}\\.v(\\d+)${ext.replace(/[.]/g, '\\.')}$`,
  );
  for (const [k, v] of Object.entries(files)) {
    const m = re.exec(k);
    if (m && Number(m[1]) > best) {
      best = Number(m[1]);
      out = v;
    }
  }
  return out;
}

export type CreativeTag = 'scale' | 'keep' | 'cut' | 'too_early';

export interface AdStats {
  spend: number;
  impressions: number;
  ctr: number | null; // 0–1
  metaPurchases: number;
  metaRoas: number | null;
  /** Meta landing page views: what a click costs once the page actually opens. */
  landingPageViews?: number;
  /** Video only: 3-second plays ÷ impressions. */
  hookRate?: number | null;
}

/** Leading signals need this many impressions before an ad without purchases is cut on them. */
export const MIN_SIGNAL_IMPRESSIONS = 3000;

/** Below this many impressions an ad without purchases is not judged. */
export const MIN_AD_IMPRESSIONS = 1500;

/**
 * Scale / keep / cut / too early for one ad, against its own campaign, on
 * Meta-reported purchases (per-ad first-party orders are too thin to judge).
 */
export function creativeVerdict(
  ad: AdStats,
  campaign: AdStats,
): { tag: CreativeTag; reason: string } {
  const cpp = (s: AdStats) =>
    s.metaPurchases ? s.spend / s.metaPurchases : null;
  const campCpp = cpp(campaign);
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const ctr = (n: number | null) =>
    n === null ? '–' : `${(n * 100).toFixed(2)}%`;
  const lowCtr =
    ad.ctr !== null && campaign.ctr !== null && ad.ctr < campaign.ctr * 0.8;

  if (ad.metaPurchases === 0 && ad.impressions < MIN_AD_IMPRESSIONS)
    return {
      tag: 'too_early',
      reason: `Only ${ad.impressions.toLocaleString('en-IN')} impressions so far`,
    };
  if (ad.metaPurchases >= 2) {
    const adCpp = cpp(ad)!;
    if (
      (campCpp !== null && adCpp <= campCpp * 0.8) ||
      (ad.metaRoas !== null &&
        campaign.metaRoas !== null &&
        ad.metaRoas >= Math.max(1, campaign.metaRoas * 1.25))
    )
      return {
        tag: 'scale',
        reason: `${ad.metaPurchases} purchases at ${inr(adCpp)} each vs ${campCpp === null ? '–' : inr(campCpp)} for the campaign`,
      };
  }
  if (ad.metaPurchases === 0) {
    // Spent what the campaign usually pays for a purchase (twice, or 1.5× with a weak CTR) and got none.
    const bar = campCpp ?? campaign.spend * 0.15;
    if (ad.spend >= bar * 2 || (lowCtr && ad.spend >= bar * 1.5))
      return {
        tag: 'cut',
        reason: `${inr(ad.spend)} spent, 0 purchases${lowCtr ? `, CTR ${ctr(ad.ctr)} vs ${ctr(campaign.ctr)}` : ''}`,
      };
  }
  // No purchases to judge on yet: use what happens before the purchase.
  if (ad.metaPurchases === 0 && ad.impressions >= MIN_SIGNAL_IMPRESSIONS) {
    const cplv = (x: AdStats) =>
      x.landingPageViews ? x.spend / x.landingPageViews : null;
    const adCplv = cplv(ad);
    const campCplv = cplv(campaign);
    const weakCtr =
      ad.ctr !== null && campaign.ctr !== null && ad.ctr < campaign.ctr * 0.5;
    const dearPage =
      campCplv !== null &&
      (adCplv === null
        ? ad.spend >= campCplv * 3
        : adCplv > campCplv * 2);
    if (weakCtr || dearPage)
      return {
        tag: 'cut',
        reason: [
          weakCtr && `CTR ${ctr(ad.ctr)} vs ${ctr(campaign.ctr)} for the campaign`,
          dearPage &&
            (adCplv === null
              ? `${inr(ad.spend)} spent and no page opened`
              : `${inr(adCplv)} per page opened vs ${inr(campCplv!)}`),
          ad.hookRate != null && `${(ad.hookRate * 100).toFixed(1)}% watch past 3 s`,
        ]
          .filter(Boolean)
          .join(', '),
      };
    if (
      ad.ctr !== null &&
      campaign.ctr !== null &&
      ad.ctr >= campaign.ctr * 1.5 &&
      (adCplv === null || campCplv === null || adCplv <= campCplv)
    )
      return {
        tag: 'keep',
        reason: `Best early signal: CTR ${ctr(ad.ctr)} vs ${ctr(campaign.ctr)}${adCplv !== null ? `, ${inr(adCplv)} per page opened` : ''}; no purchase yet`,
      };
  }
  return {
    tag: 'keep',
    reason: ad.metaPurchases
      ? `${ad.metaPurchases} purchase${ad.metaPurchases > 1 ? 's' : ''}, CTR ${ctr(ad.ctr)}`
      : `No purchase yet on ${inr(ad.spend)}, CTR ${ctr(ad.ctr)}`,
  };
}

/** One ad's numbers, as the report merges them. */
export interface AdRow {
  id: string;
  name: string;
  format: string | null;
  title: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  landingPageViews: number;
  metaPurchases: number;
  metaPurchaseValue: number;
  firstPartyOrders: number;
  plays3s: number;
}

/**
 * The same creative running in several ad sets is one ad to the owner:
 * rows with the same name, format and title are summed (ids kept).
 */
export function mergeAdRows<T extends AdRow>(rows: T[]): (T & { ids: string[] })[] {
  const out = new Map<string, T & { ids: string[] }>();
  for (const r of rows) {
    const k = `${r.name.trim().toLowerCase()}|${r.format ?? ''}|${r.title.trim().toLowerCase()}`;
    const m = out.get(k);
    if (!m) {
      out.set(k, { ...r, ids: [r.id] });
      continue;
    }
    m.ids.push(r.id);
    for (const f of [
      'spend',
      'impressions',
      'linkClicks',
      'landingPageViews',
      'metaPurchases',
      'metaPurchaseValue',
      'firstPartyOrders',
      'plays3s',
    ] as const)
      (m as AdRow)[f] += r[f];
  }
  return [...out.values()];
}
