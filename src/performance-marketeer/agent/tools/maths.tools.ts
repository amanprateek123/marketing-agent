import { z } from 'zod';
import {
  anomalies,
  calc,
  changepoint,
  compareProportions,
  comparePoisson,
  impactRupees,
} from './maths.logic';
import { PmToolDef } from './pm-tool';

const series = z
  .array(z.number())
  .min(5)
  .max(400)
  .describe('Numeric series in time order, e.g. daily CPM');
const labels = z
  .array(z.string())
  .optional()
  .describe('Optional labels (e.g. dates), same length as values');
const label = (l: string[] | undefined, i: number) => l?.[i] ?? String(i);

/** Maths tools — every number the model reports must come from code, not mental arithmetic. */
export function mathsTools(): PmToolDef[] {
  return [
    {
      name: 'calc',
      description:
        'Evaluate an arithmetic expression exactly. Supports numbers, + - * / ^ (power), parentheses, min(), max(), abs(), sqrt(), round(x, digits). Use it for EVERY number you derive (shares, averages, deltas, ₹ per day). Returns { expression, value }.',
      shape: {
        expression: z
          .string()
          .max(500)
          .describe('e.g. "(43210 - 38100) / 38100 * 100"'),
      },
      run: async ({ expression }) => ({ expression, value: calc(expression) }),
    },
    {
      name: 'stat_compare',
      description:
        'Is a difference real or noise? kind "proportion": two rates with counts, e.g. CTR (link clicks / impressions) or conversion (orders / visitors) — returns both rates, difference a − b with a 95% interval (Newcombe/Wilson) and a verdict "significant" / "not distinguishable from noise". kind "poisson": two event counts over an exposure, e.g. orders per ₹ spend or orders per day — returns rates, difference with 95% interval, rate ratio a/b with 95% interval, verdict. Rates are fractions (0.012 = 1.2%), not percentages.',
      shape: {
        kind: z.enum(['proportion', 'poisson']),
        a: z
          .object({
            count: z
              .number()
              .min(0)
              .describe('successes / events, e.g. clicks or orders'),
            total: z
              .number()
              .positive()
              .describe(
                'trials (proportion) or exposure, e.g. impressions, ₹ spend, days (poisson)',
              ),
            label: z.string().optional(),
          })
          .describe('the period / entity being tested (e.g. last 7 days)'),
        b: z
          .object({
            count: z.number().min(0),
            total: z.number().positive(),
            label: z.string().optional(),
          })
          .describe('the baseline (e.g. the 7 days before)'),
      },
      run: async ({ kind, a, b }) => ({
        kind,
        a: a.label ?? 'a',
        b: b.label ?? 'b',
        ...(kind === 'proportion'
          ? compareProportions(
              { k: a.count, n: a.total },
              { k: b.count, n: b.total },
            )
          : comparePoisson(
              { count: a.count, exposure: a.total },
              { count: b.count, exposure: b.total },
            )),
      }),
    },
    {
      name: 'impact_rupees',
      description:
        "₹ per day at stake for one cause or action. REQUIRED: every cause's impactRupeesPerDay must be this tool's result (cite its ev id). Formula: impactRupeesPerDay = spendPerDay × shareAffected × (roasIfFixed − roasNow). Read it as the extra first-party revenue per day at the same spend if the cause were fixed. Use first-party ROAS. shareAffected = share of the campaign's spend the cause touches (e.g. one ad set's spend share, the share of spend going to a bad state); default 1. roasIfFixed defaults to the 1.0 target — then, when roasNow < 1, the result is the daily loss (spend − revenue) on the affected spend. For funnel/payment causes, convert the fix to a ROAS first with calc (e.g. roasNow × (1 + extra paid orders share)). Also returns ₹ per 30 days and the formula with your inputs.",
      shape: {
        spendPerDay: z
          .number()
          .min(0)
          .describe('₹ Meta spend per day (e.g. last 7 days spend / 7)'),
        roasNow: z
          .number()
          .min(0)
          .describe('current first-party ROAS of the affected spend'),
        roasIfFixed: z
          .number()
          .min(0)
          .optional()
          .describe('ROAS expected once fixed; default 1.0 (target)'),
        shareAffected: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('0–1, default 1'),
      },
      run: async (args) => ({ ...args, ...impactRupees(args) }),
    },
    {
      name: 'anomaly',
      description:
        'Robust outlier check on a numeric series (median / MAD, Iglewicz–Hoaglin modified z). Flags points with |z| > 3.5. Returns median, MAD and the flagged points { label, value, z }. Use on daily CPM, CTR, spend, orders… to tell a one-day spike from a trend.',
      shape: { values: series, labels },
      run: async ({ values, labels: l }) => {
        const r = anomalies(values);
        return {
          ...r,
          flagged: r.flagged.map((p) => ({
            label: label(l, p.index),
            value: p.value,
            z: p.z,
          })),
        };
      },
    },
    {
      name: 'changepoint',
      description:
        'Finds the single most likely level shift in a series (best split minimising squared error, each side ≥ 3 points). Returns the first point after the shift (index + label), before/after means, relative change, a t-like score and a verdict "large shift" (t ≥ 3, strict because the split was searched for) or "within noise". Use it to date when a metric moved, then match the date against edits (learning_status), festivals or account trends.',
      shape: { values: series.min(6), labels },
      run: async ({ values, labels: l }) => {
        const r = changepoint(values);
        return { ...r, label: label(l, r.index) };
      },
    },
  ];
}
