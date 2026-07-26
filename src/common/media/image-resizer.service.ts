import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
// sharp is imported this way on purpose — `import sharp from 'sharp'` compiles
// to a runtime-undefined value here and every call below then throws.
//
// tsconfig has allowSyntheticDefaultImports but NOT esModuleInterop, and
// moduleResolution defaults to node10, which ignores sharp's `exports` map and
// takes its types from package.json#types -> dist/index.d.mts (ESM shape,
// `export default sharp`). So a default import type-checks against the .d.mts
// and emits bare `sharp_1.default` with no interop wrapper — while require()
// actually resolves dist/index.cjs, whose `module.exports` IS the factory, so
// `.default` is undefined.
//
// The namespace import emits plain `require('sharp')` — correct at runtime —
// and the cast restores the callable type the ESM typings hide. Every sharp
// call below sits inside a try/catch, so getting this wrong surfaced as a
// silent `added: 0`, not an error.
import * as sharpNs from 'sharp';
const sharp = sharpNs as unknown as sharpNs.SharpConstructor;
import { S3Service } from '../storage/s3.service';

/**
 * Produces additional placement sizes of an existing creative WITHOUT cropping
 * it, by growing the canvas rather than cutting the frame.
 *
 * Why this exists: Meta centre-crops whatever single image you give it to fit
 * each placement. On a typical DR creative — headline at the top, CTA button at
 * the bottom — a centre-crop from 2:3 to 1:1 removes BOTH. The ad still serves,
 * it just serves with no hook and no call to action, which reads as weak
 * creative rather than the delivery artefact it actually is.
 *
 * The generation-side mitigation already in place (ImageGeneratorService's
 * safe-zone rule, which asks the model to keep text inside the centre 60%)
 * only helps when the model actually obeys it, and costs you 40% of the frame
 * even when it does. This is the deterministic complement: give Meta an asset
 * already at the right ratio and there is nothing left for it to crop.
 *
 * The source pixels are never resampled. They are composited at native 1:1
 * scale onto a larger canvas whose margin is filled with a blurred, dimmed,
 * cover-scaled copy of the same image, and written out as PNG (lossless), so
 * the region the original occupies is bit-identical to the input. The canvas
 * can only ever grow — see the invariant check in extendBuffer().
 *
 * Cost: no API calls, no model inference. Pure local CPU, ~0.3s per image.
 */

export type ExtendRatio = '9:16' | '4:5' | '1:1' | '16:9';

export const EXTEND_RATIOS: readonly ExtendRatio[] = ['9:16', '4:5', '1:1', '16:9'];

const RATIO_VALUE: Record<ExtendRatio, number> = {
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '16:9': 16 / 9,
};

/**
 * How far off the target still counts as "already this ratio" — don't burn CPU
 * or S3 storage adding a 3px band. Also absorbs the rounding in extendBuffer(),
 * which snaps to even dimensions and so never lands exactly on the target.
 *
 * 16:9 is deliberately looser. Meta's own link/feed image format is 1200x628
 * (1.91:1), which everyone including Meta's docs calls "16:9" but is actually
 * 7.5% off 1.778 — and a 1.91:1 asset is already a native Meta size, so
 * padding it with blur bars to hit exactly 16:9 makes it worse, not better.
 * An audit of 60 live images found 16 in exactly this shape. 0.08 covers it
 * with room to spare; the closest two targets (4:5 and 1:1) sit 25% apart, so
 * even this widened band cannot make one ratio absorb another.
 */
const RATIO_TOLERANCE: Record<ExtendRatio, number> = {
  '9:16': 0.01,
  '4:5': 0.01,
  '1:1': 0.01,
  '16:9': 0.08,
};

/** True when `width`x`height` already satisfies `ratio` closely enough to skip. */
function satisfiesRatio(width: number, height: number, ratio: ExtendRatio): boolean {
  const target = RATIO_VALUE[ratio];
  return Math.abs(width / height - target) / target <= RATIO_TOLERANCE[ratio];
}

/**
 * Which of the four placement ratios these pixels actually ARE, or undefined
 * for a shape that is none of them (a raw 2:3 generation, say). Use this to
 * label an asset for Meta instead of forwarding its `aspectRatio` tag, which
 * records what was requested rather than what came back.
 *
 * Returns the closest match when a shape satisfies more than one band, which
 * only 16:9's widened tolerance makes possible.
 */
export function classifyRatio(width?: number, height?: number): ExtendRatio | undefined {
  if (!width || !height) return undefined;
  const actual = width / height;
  return EXTEND_RATIOS
    .filter((r) => satisfiesRatio(width, height, r))
    .sort(
      (a, b) =>
        Math.abs(actual - RATIO_VALUE[a]) / RATIO_VALUE[a] -
        Math.abs(actual - RATIO_VALUE[b]) / RATIO_VALUE[b],
    )[0];
}

/**
 * Structural shape of a creative-package `images[]` entry. Deliberately not
 * importing ImageCreative from the creative module — this service lives in
 * common/ and is used from both CreativeModule and CampaignsModule, and a
 * domain import here would make that a cycle.
 */
export interface ResizableImage {
  variantIndex: number;
  imageUrl: string;
  imagePrompt?: string;
  /** What was REQUESTED at generation time. Not trustworthy as a shape — see width/height. */
  aspectRatio?: string;
  resolution?: string;
  rejected?: boolean;
  /** MEASURED pixels, backfilled by ensureSizes() on every asset it downloads. */
  width?: number;
  height?: number;
  /** Set by this service. See ensureSizes() for why it must never be a source. */
  extendedFrom?: string;
  [key: string]: any;
}

/**
 * The guarantee ensureSizes() just made, per variant: which exact asset now
 * satisfies each requested ratio, keyed by MEASUREMENT rather than by tag.
 *
 * This exists so nothing downstream has to search `images[]` for a matching
 * `aspectRatio` string. Two entries on one variant can legitimately carry the
 * same tag — a 1200x628 original tagged '16:9' plus a derived true 16:9, say —
 * and a `.find()` over the array resolves that collision by array position,
 * which is an accident of append order rather than a decision. Selection at
 * launch should be a lookup in here, not a search out there.
 */
export type RatioMap = Record<number, Partial<Record<ExtendRatio, string>>>;

export interface ExtendResult {
  buffer: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  left: number;
  top: number;
  /** True when the source was already at the target ratio and was returned untouched. */
  unchanged: boolean;
}

@Injectable()
export class ImageResizerService {
  private readonly logger = new Logger(ImageResizerService.name);

  constructor(private readonly s3Service: S3Service) {}

  /**
   * Grow `source` to `ratio` without cropping. Returns the source buffer
   * untouched when it is already at that ratio.
   */
  async extendBuffer(source: Buffer, ratio: ExtendRatio): Promise<ExtendResult> {
    const meta = await sharp(source).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) throw new Error('Could not read source image dimensions');

    const target = RATIO_VALUE[ratio];
    const current = W / H;

    if (satisfiesRatio(W, H, ratio)) {
      return { buffer: source, width: W, height: H, sourceWidth: W, sourceHeight: H, left: 0, top: 0, unchanged: true };
    }

    // Extend whichever axis is short; the other keeps the source's native
    // pixel count. Growing one axis is the ONLY operation performed, which is
    // what makes cropping structurally impossible rather than merely avoided.
    let outW: number;
    let outH: number;
    if (target > current) {
      outH = H;
      outW = Math.round(H * target);
    } else {
      outW = W;
      outH = Math.round(W / target);
    }
    // Even dimensions (some encoders/players dislike odd), and never below the
    // source — Math.max is the invariant, the modulo is just the rounding.
    outW = Math.max(W, outW + (outW % 2));
    outH = Math.max(H, outH + (outH % 2));

    if (outW < W || outH < H) {
      throw new Error(`Refusing to shrink ${W}x${H} to ${outW}x${outH} for ${ratio} — that would crop content`);
    }

    const left = Math.round((outW - W) / 2);
    const top = Math.round((outH - H) / 2);

    // Margin fill: the same image, cover-scaled to the full canvas and blurred
    // hard, so the extension carries the original's colour and lighting and
    // reads as more of the same scene. Dimmed slightly so the sharp original
    // stays the focal plane instead of competing with its own background.
    const sigma = Math.max(8, Math.round(Math.max(outW, outH) / 45));
    const background = await sharp(source)
      .resize(outW, outH, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      .blur(sigma)
      .modulate({ brightness: 0.82, saturation: 1.05 })
      .toBuffer();

    const buffer = await sharp(background)
      .composite([{ input: source, left, top }])
      .png({ compressionLevel: 9 })
      .toBuffer();

    return { buffer, width: outW, height: outH, sourceWidth: W, sourceHeight: H, left, top, unchanged: false };
  }

  /**
   * Extend a hosted image to `ratio` and upload the result. Returns the
   * original URL unchanged when it is already at that ratio.
   */
  async extendFromUrl(
    sourceUrl: string,
    ratio: ExtendRatio,
    tenantId: string,
    runId: string,
  ): Promise<{ imageUrl: string; width: number; height: number; unchanged: boolean }> {
    const source = await this.download(sourceUrl);
    const result = await this.extendBuffer(source, ratio);

    if (result.unchanged) {
      this.logger.log(`Already ${ratio} (${result.width}x${result.height}) — reusing source: ${sourceUrl}`);
      return { imageUrl: sourceUrl, width: result.width, height: result.height, unchanged: true };
    }

    // tenantId prefix is mandatory on every S3 path.
    const key = `${tenantId}/images/${runId}-extend-${ratio.replace(':', 'x')}-${Date.now()}.png`;
    const imageUrl = await this.s3Service.uploadBuffer(result.buffer, key, 'image/png');

    this.logger.log(
      `Extended to ${ratio}: ${result.sourceWidth}x${result.sourceHeight} -> ${result.width}x${result.height}, ` +
      `original placed at (${result.left},${result.top}) at native size`,
    );
    return { imageUrl, width: result.width, height: result.height, unchanged: false };
  }

  /**
   * Fill in whichever of `ratios` a variant does not already have, returning a
   * new images[] array with the additions appended. Existing entries are never
   * modified or removed.
   *
   * Ratio presence is decided by MEASURING each asset, not by reading its
   * `aspectRatio` tag. The tags are known-unreliable: gpt-image has no native
   * 4:5 and snaps those requests to 1024x1024 square, and its "9:16" is really
   * 1024x1536 (2:3, 0.667 — not 0.5625), but entries are tagged with what was
   * REQUESTED either way. Trusting the tag would skip sizes that aren't there.
   *
   * An asset this service produced is never used as the source for another
   * extend — extending an extend stacks blur margin on top of blur margin and
   * shrinks the real content to a stamp in the middle.
   *
   * Two things come back besides the images:
   *  - every entry it downloaded is annotated with its MEASURED width/height,
   *    so later reads (launch selection, gallery badges) never re-download and
   *    never have to trust `aspectRatio`;
   *  - `byRatio`, the explicit per-variant ratio -> imageUrl guarantee. Callers
   *    should select from that rather than searching images[] by tag — see the
   *    RatioMap docblock for why a tag search is positional, not deterministic.
   *
   * `includeRejected` exists because launch and this service disagree about
   * rejected assets by design: campaign launch deliberately ignores `rejected`
   * (see the schema comment on ImageCreative.rejected) so an in-flight campaign
   * stays launchable, while manual/dashboard resizing should not spend S3 on
   * assets a human discarded. Launch passes true so the sizes it guarantees
   * cover exactly the set it will actually upload; everything else omits it.
   */
  async ensureSizes(
    images: ResizableImage[],
    ratios: readonly ExtendRatio[],
    tenantId: string,
    runId: string,
    options: { variantIndex?: number; includeRejected?: boolean } = {},
  ): Promise<{ images: ResizableImage[]; added: number; byRatio: RatioMap }> {
    const { variantIndex, includeRejected = false } = options;
    const result: ResizableImage[] = [...images];
    const byRatio: RatioMap = {};
    let added = 0;

    const usable = (i: ResizableImage) => !!i.imageUrl && (includeRejected || !i.rejected);

    const variants = variantIndex === undefined
      ? [...new Set(images.filter(usable).map((i) => i.variantIndex))]
      : [variantIndex];

    for (const variant of variants) {
      const entries = result.filter((i) => i.variantIndex === variant && usable(i));
      if (!entries.length) continue;

      const measured: Array<{ entry: ResizableImage; buffer: Buffer; width: number; height: number }> = [];
      for (const entry of entries) {
        try {
          const buffer = await this.download(entry.imageUrl);
          const meta = await sharp(buffer).metadata();
          if (meta.width && meta.height) {
            // Backfill onto the entry itself so this measurement is persisted
            // by whichever caller writes images[] back, and nobody downstream
            // has to re-download to learn an asset's real shape.
            entry.width = meta.width;
            entry.height = meta.height;
            measured.push({ entry, buffer, width: meta.width, height: meta.height });
          }
        } catch (err: any) {
          this.logger.warn(`Could not measure image for variant ${variant} (${entry.imageUrl}): ${err.message}`);
        }
      }
      if (!measured.length) continue;

      // Prefer a non-derived asset; among those, the most pixels. Falling back
      // to a derived one is better than producing nothing, but shouldn't
      // happen for a package that still has its original.
      const originals = measured.filter((m) => !m.entry.extendedFrom);
      const source = (originals.length ? originals : measured)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];

      const ratioMap: Partial<Record<ExtendRatio, string>> = {};
      byRatio[variant] = ratioMap;

      for (const ratio of ratios) {
        // Among assets that already satisfy this ratio, record the largest —
        // several can qualify (an original plus a derived one), and "biggest
        // correct asset" is a decision rather than an array-order accident.
        const already = measured
          .filter((m) => satisfiesRatio(m.width, m.height, ratio))
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (already) {
          ratioMap[ratio] = already.entry.imageUrl;
          continue;
        }

        try {
          const extended = await this.extendBuffer(source.buffer, ratio);
          const key = `${tenantId}/images/${runId}-extend-v${variant}-${ratio.replace(':', 'x')}-${Date.now()}.png`;
          const imageUrl = await this.s3Service.uploadBuffer(extended.buffer, key, 'image/png');

          const entry: ResizableImage = {
            variantIndex: variant,
            // Carried so the Gallery/regenerate paths still have something to
            // work with; the prompt describes the SOURCE composition, which is
            // exactly what this asset still contains.
            imagePrompt: source.entry.imagePrompt ?? '',
            imageUrl,
            aspectRatio: ratio,
            resolution: source.entry.resolution,
            // Measured, not nominal — this one is guaranteed accurate, since
            // extendBuffer() just produced these exact dimensions.
            width: extended.width,
            height: extended.height,
            extendedFrom: source.entry.imageUrl,
          };

          result.push(entry);
          measured.push({ entry, buffer: extended.buffer, width: extended.width, height: extended.height });
          ratioMap[ratio] = imageUrl;
          added++;

          this.logger.log(
            `Variant ${variant}: added ${ratio} (${extended.width}x${extended.height}) ` +
            `from ${extended.sourceWidth}x${extended.sourceHeight} — content intact`,
          );
        } catch (err: any) {
          this.logger.warn(`Extend to ${ratio} failed for variant ${variant}: ${err.message}`);
        }
      }
    }

    return { images: result, added, byRatio };
  }

  private async download(url: string): Promise<Buffer> {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return Buffer.from(response.data);
  }
}
