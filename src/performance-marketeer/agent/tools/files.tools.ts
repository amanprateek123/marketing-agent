import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { PM_FILES } from '../pm-agent.types';
import { PmToolDef } from './pm-tool';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9]{5,30}$/;
/** A phase file, or one file under helpers/. No other sub-paths. */
const FILE_RE = /^(helpers\/)?[a-z0-9][a-z0-9._-]{0,80}$/i;
const HELPER_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const PAST_DAYS = 14;
const MAX_READ = 100_000;
const MAX_HELPER = 200_000;

/** Resolve `parts` under `base` and refuse anything that escapes it. */
function inside(base: string, ...parts: string[]) {
  const root = path.resolve(base);
  const p = path.resolve(root, ...parts);
  if (!p.startsWith(root + path.sep)) throw new Error('Path not allowed');
  return p;
}

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Disk-only memory: earlier runs of this campaign, and a scratch folder for helpers. */
export function filesTools(rootDir: string): PmToolDef[] {
  return [
    {
      name: 'past_runs',
      description: `Earlier runs of THIS campaign, from disk (campaigns/<id>/<date>/). Without arguments: the last ${PAST_DAYS} earlier run dates, newest first, each with its file names (00-brief.md, 01-investigate.v1.md … 05-actions.md). With date + file: that file's text (cut at 100 KB). Use it to see what was concluded and recommended before; the journal tool says what was actually done. Today's files are read with Read, not this tool.`,
      shape: {
        date: z
          .string()
          .regex(DAY_RE)
          .optional()
          .describe('YYYY-MM-DD of an earlier run'),
        file: z
          .string()
          .regex(FILE_RE)
          .optional()
          .describe('file name from the listing, e.g. 05-actions.md'),
      },
      noEvidence: true,
      run: async ({ date, file }, ctx) => {
        if (!ID_RE.test(ctx.campaignId)) throw new Error('Bad campaign id');
        const base = inside(rootDir, 'campaigns', ctx.campaignId);
        if (date || file) {
          if (!date || !file)
            throw new Error('Pass both date and file, or neither');
          if (!DAY_RE.test(date) || !FILE_RE.test(file))
            throw new Error('Bad date or file name');
          if (date >= ctx.date)
            throw new Error("Only earlier dates; read today's files with Read");
          const p = inside(base, date, file);
          const text = await fs.readFile(p, 'utf8').catch(() => {
            throw new Error(`No file ${file} on ${date}`);
          });
          return {
            date,
            file,
            text:
              text.length > MAX_READ
                ? text.slice(0, MAX_READ) + '\n…[cut]'
                : text,
          };
        }
        if (!(await exists(base))) return { runs: [] };
        const dates = (await fs.readdir(base))
          .filter((d) => DAY_RE.test(d) && d < ctx.date)
          .sort()
          .reverse()
          .slice(0, PAST_DAYS);
        const runs = await Promise.all(
          dates.map(async (d) => {
            const dir = inside(base, d);
            const top = (await fs.readdir(dir, { withFileTypes: true }))
              .filter((f) => f.isFile() && FILE_RE.test(f.name))
              .map((f) => f.name);
            const helpers = path.join(dir, PM_FILES.helpers);
            const extra = (await exists(helpers))
              ? (await fs.readdir(helpers))
                  .filter((f) => FILE_RE.test(f))
                  .map((f) => `${PM_FILES.helpers}/${f}`)
              : [];
            return { date: d, files: [...top.sort(), ...extra] };
          }),
        );
        return { runs };
      },
    },
    {
      name: 'write_helper',
      description:
        'Save a text file (notes, a table, a small dataset, a helper\'s output) into this run\'s helpers/ folder so later phases or helpers can Read it. Name: lowercase letters, digits, . _ - (max 61 chars, e.g. "geo-table.md"); content max 200 KB; overwrites a file of the same name. Returns its path relative to the run folder.',
      shape: {
        name: z.string().regex(HELPER_RE),
        content: z.string(),
      },
      noEvidence: true,
      run: async ({ name, content }, ctx) => {
        if (!HELPER_RE.test(name)) throw new Error('Bad file name');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_HELPER) throw new Error('Content over 200 KB');
        const dir = inside(ctx.dir, PM_FILES.helpers);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(inside(dir, name), content, 'utf8');
        return { path: `${PM_FILES.helpers}/${name}`, bytes };
      },
    },
  ];
}
