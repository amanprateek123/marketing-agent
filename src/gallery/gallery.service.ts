import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GalleryTopic, GalleryTopicDocument } from './schemas/gallery-topic.schema';
import { GallerySheet, GallerySheetDocument } from './schemas/gallery-sheet.schema';
import { GalleryAsset, GalleryAssetDocument, GalleryAssetType } from './schemas/gallery-asset.schema';
import { CreativePackage, CreativePackageDocument, ImageCreative, VideoCreative } from '../creative/schemas/creative-package.schema';

const UNSORTED_SHEET_NAME = 'Unsorted';

export interface ResolvedGalleryAsset {
  _id: string;
  assetType: GalleryAssetType;
  variantIndex: number;
  sourcePackageId: string;
  assetUrl: string;
  aspectRatio?: string;
  resolution?: string;
  /**
   * Alternate placement sizes of THIS asset — canvas-extended copies the
   * resizer derived, and ready-made ones uploaded alongside the creative —
   * never separate creatives. They share their source's variantIndex, so
   * findUntrackedAssets already declines to give them their own pointer. One
   * gallery row, several sizes. Empty for assets that have none.
   * `imageUrl` is a misnomer kept for shape compatibility — for a video
   * asset (assetType: 'video') it holds that size's videoUrl, not an image.
   */
  sizes?: Array<{ imageUrl: string; aspectRatio?: string; width?: number; height?: number; derived: boolean }>;
}

/**
 * Organizes creatives into Topic -> Sheet -> Asset (mirrors the user's
 * Google Sheets workflow: one workbook per topic, tabs for segments,
 * movable rows). Deliberately does NOT touch CreativePackage or any
 * campaign/launch code — GalleryAsset is just a movable pointer, resolved
 * live against the source package on every read. See
 * gallery-asset.schema.ts for why there's no denormalized URL cache.
 */
@Injectable()
export class GalleryService {
  private readonly logger = new Logger(GalleryService.name);

  constructor(
    @InjectModel(GalleryTopic.name) private readonly topicModel: Model<GalleryTopicDocument>,
    @InjectModel(GallerySheet.name) private readonly sheetModel: Model<GallerySheetDocument>,
    @InjectModel(GalleryAsset.name) private readonly assetModel: Model<GalleryAssetDocument>,
    @InjectModel(CreativePackage.name) private readonly packageModel: Model<CreativePackageDocument>,
  ) {}

  /**
   * Called right after a CreativePackage finishes generating successfully
   * (CreativeProducerService.produce(), inside the `!allFailed` branch).
   * Find-or-creates the topic + its "Unsorted" sheet, then adds one
   * GalleryAsset per usable image/video/carousel card. Safe to call
   * multiple times for the same package (e.g. on a regenerate run) — it
   * only adds pointers for variants that don't already have one, so it
   * never duplicates or resets a variant a user already moved elsewhere.
   */
  async autoPopulate(
    tenantId: string,
    topicName: string,
    sourcePackageId: string,
    images: ImageCreative[],
    video: VideoCreative | null,
    carouselCards: Array<{ slotIndex: number; imageUrl: string }>,
  ): Promise<void> {
    const toCreate = await this.findUntrackedAssets(tenantId, sourcePackageId, images, video, carouselCards);
    if (toCreate.length === 0) return;

    const topic = await this.findOrCreateTopic(tenantId, topicName);
    const sheet = await this.findOrCreateSheet(tenantId, topic._id.toString(), UNSORTED_SHEET_NAME);
    await this.insertAssets(tenantId, sheet._id.toString(), sourcePackageId, toCreate);
    this.logger.log(`Gallery auto-populated: tenantId=${tenantId} topic="${topicName}" packageId=${sourcePackageId} added=${toCreate.length}`);
  }

  /**
   * Same as autoPopulate, but targets an EXISTING sheet directly instead of
   * resolving/creating a topic's "Unsorted" sheet — used when uploading a
   * creative straight into a specific sheet (e.g. from the Gallery topic
   * page's own upload form) so it doesn't need a manual move afterward.
   */
  async populateSheet(
    tenantId: string,
    sheetId: string,
    sourcePackageId: string,
    images: ImageCreative[],
    video: VideoCreative | null,
    carouselCards: Array<{ slotIndex: number; imageUrl: string }>,
  ): Promise<void> {
    const sheet = await this.sheetModel.findOne({ _id: sheetId, tenantId }).lean().exec();
    if (!sheet) throw new NotFoundException(`Gallery sheet ${sheetId} not found`);

    const toCreate = await this.findUntrackedAssets(tenantId, sourcePackageId, images, video, carouselCards);
    if (toCreate.length === 0) return;

    await this.insertAssets(tenantId, sheetId, sourcePackageId, toCreate);
    this.logger.log(`Gallery populated directly into sheet: tenantId=${tenantId} sheetId=${sheetId} packageId=${sourcePackageId} added=${toCreate.length}`);
  }

  private async findUntrackedAssets(
    tenantId: string,
    sourcePackageId: string,
    images: ImageCreative[],
    video: VideoCreative | null,
    carouselCards: Array<{ slotIndex: number; imageUrl: string }>,
  ): Promise<Array<{ assetType: GalleryAssetType; variantIndex: number }>> {
    const existing = await this.assetModel
      .find({ tenantId, sourcePackageId })
      .select('assetType variantIndex')
      .lean()
      .exec();
    const alreadyTracked = new Set(existing.map(a => `${a.assetType}-${a.variantIndex}`));

    const toCreate: Array<{ assetType: GalleryAssetType; variantIndex: number }> = [];
    for (const img of images) {
      if (img.imageUrl && !alreadyTracked.has(`image-${img.variantIndex}`)) {
        toCreate.push({ assetType: 'image', variantIndex: img.variantIndex });
        // Mark it here, not just from what's already in the DB: several
        // entries can share a variantIndex (alternate sizes of one creative),
        // and they belong on ONE gallery row, resolved together by the join
        // below. Without this, a package arriving with its sizes already
        // attached — an upload carrying them — would insert a duplicate
        // pointer per size, each rendering the same creative.
        alreadyTracked.add(`image-${img.variantIndex}`);
      }
    }
    if (video?.videoUrl && !alreadyTracked.has('video-0')) {
      toCreate.push({ assetType: 'video', variantIndex: 0 });
    }
    for (const card of carouselCards) {
      if (card.imageUrl && !alreadyTracked.has(`carousel_card-${card.slotIndex}`)) {
        toCreate.push({ assetType: 'carousel_card', variantIndex: card.slotIndex });
      }
    }
    return toCreate;
  }

  private async insertAssets(
    tenantId: string,
    sheetId: string,
    sourcePackageId: string,
    toCreate: Array<{ assetType: GalleryAssetType; variantIndex: number }>,
  ): Promise<void> {
    await this.assetModel.insertMany(
      toCreate.map(a => ({
        tenantId,
        sheetId,
        assetType: a.assetType,
        sourcePackageId,
        variantIndex: a.variantIndex,
      })),
    );
  }

  private async findOrCreateTopic(tenantId: string, name: string): Promise<GalleryTopicDocument> {
    const existing = await this.topicModel.findOne({ tenantId, name }).exec();
    if (existing) return existing;
    return this.topicModel.create({ tenantId, name });
  }

  private async findOrCreateSheet(tenantId: string, topicId: string, name: string): Promise<GallerySheetDocument> {
    const existing = await this.sheetModel.findOne({ tenantId, topicId, name }).exec();
    if (existing) return existing;
    return this.sheetModel.create({ tenantId, topicId, name });
  }

  async listTopics(tenantId: string) {
    const topics = await this.topicModel.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();
    const sheets = await this.sheetModel.find({ tenantId }).lean().exec();
    // sheetId is stored as a plain string, not an ObjectId ref, so the topic
    // rollup is done in JS rather than a $lookup aggregation join.
    const sheetIdToTopicId = new Map(sheets.map(s => [s._id.toString(), s.topicId]));
    const assetCountByTopic = new Map<string, number>();
    // Same rule as listSheets: count what renders, not what's referenced.
    // Needs the full pointer (not just sheetId) so each one can be resolved.
    const allAssets = await this.assetModel.find({ tenantId }).lean().exec();
    const { visible } = await this.countVisible(allAssets);
    for (const asset of allAssets) {
      const topicId = sheetIdToTopicId.get(asset.sheetId);
      if (!topicId) continue;
      if (!visible.has(asset._id.toString())) continue;
      assetCountByTopic.set(topicId, (assetCountByTopic.get(topicId) ?? 0) + 1);
    }
    const sheetCountByTopic = new Map<string, number>();
    for (const s of sheets) {
      sheetCountByTopic.set(s.topicId, (sheetCountByTopic.get(s.topicId) ?? 0) + 1);
    }
    return topics.map(t => ({
      _id: t._id.toString(),
      name: t.name,
      sheetCount: sheetCountByTopic.get(t._id.toString()) ?? 0,
      assetCount: assetCountByTopic.get(t._id.toString()) ?? 0,
    }));
  }

  async createTopic(tenantId: string, name: string) {
    const topic = await this.findOrCreateTopic(tenantId, name);
    await this.findOrCreateSheet(tenantId, topic._id.toString(), UNSORTED_SHEET_NAME);
    return { _id: topic._id.toString(), name: topic.name };
  }

  async renameTopic(tenantId: string, topicId: string, name: string) {
    const topic = await this.topicModel.findOneAndUpdate({ _id: topicId, tenantId }, { $set: { name } }, { new: true }).lean().exec();
    if (!topic) throw new NotFoundException(`Gallery topic ${topicId} not found`);
    return { _id: topic._id.toString(), name: topic.name };
  }

  async listSheets(tenantId: string, topicId: string) {
    const topic = await this.topicModel.findOne({ _id: topicId, tenantId }).lean().exec();
    if (!topic) throw new NotFoundException(`Gallery topic ${topicId} not found`);
    const sheets = await this.sheetModel.find({ tenantId, topicId }).sort({ createdAt: 1 }).lean().exec();
    const pointers = await this.assetModel
      .find({ tenantId, sheetId: { $in: sheets.map(s => s._id.toString()) } })
      .lean()
      .exec();

    // assetCount counts what the sheet will actually RENDER, not how many
    // pointer rows exist — the two diverge the moment an asset is rejected or
    // its source package is deleted, and a badge that disagrees with the grid
    // below it looks like a bug in the grid.
    const { visible, hiddenBySheet } = await this.countVisible(pointers);
    const countBySheet = new Map<string, number>();
    for (const p of pointers) {
      if (!visible.has(p._id.toString())) continue;
      countBySheet.set(p.sheetId, (countBySheet.get(p.sheetId) ?? 0) + 1);
    }

    return sheets.map(s => ({
      _id: s._id.toString(),
      name: s.name,
      assetCount: countBySheet.get(s._id.toString()) ?? 0,
      // Pointers that exist but resolve to nothing — almost always a rejected
      // asset, which is reversible. Surfaced so "my creative disappeared" has a
      // visible answer instead of being an unexplained gap.
      hiddenCount: hiddenBySheet.get(s._id.toString()) ?? 0,
    }));
  }

  async createSheet(tenantId: string, topicId: string, name: string) {
    const topic = await this.topicModel.findOne({ _id: topicId, tenantId }).lean().exec();
    if (!topic) throw new NotFoundException(`Gallery topic ${topicId} not found`);
    const sheet = await this.findOrCreateSheet(tenantId, topicId, name);
    return { _id: sheet._id.toString(), name: sheet.name };
  }

  async renameSheet(tenantId: string, sheetId: string, name: string) {
    const sheet = await this.sheetModel.findOneAndUpdate({ _id: sheetId, tenantId }, { $set: { name } }, { new: true }).lean().exec();
    if (!sheet) throw new NotFoundException(`Gallery sheet ${sheetId} not found`);
    return { _id: sheet._id.toString(), name: sheet.name };
  }

  /** Every "Topic / Sheet" pair for the tenant — powers the move-asset destination picker. */
  async listAllSheetsWithTopics(tenantId: string) {
    const topics = await this.topicModel.find({ tenantId }).lean().exec();
    const sheets = await this.sheetModel.find({ tenantId }).lean().exec();
    const topicById = new Map(topics.map(t => [t._id.toString(), t.name]));
    return sheets
      .map(s => ({
        sheetId: s._id.toString(),
        sheetName: s.name,
        topicId: s.topicId,
        topicName: topicById.get(s.topicId) ?? '(unknown topic)',
      }))
      .filter(s => topicById.has(s.topicId));
  }

  async listSheetAssets(tenantId: string, sheetId: string): Promise<ResolvedGalleryAsset[]> {
    const sheet = await this.sheetModel.findOne({ _id: sheetId, tenantId }).lean().exec();
    if (!sheet) throw new NotFoundException(`Gallery sheet ${sheetId} not found`);
    const assets = await this.assetModel.find({ tenantId, sheetId }).sort({ createdAt: 1 }).lean().exec();
    return this.resolveAssets(assets);
  }

  /** Sheet metadata only (no assets) — e.g. for defaulting a name elsewhere to the sheet's own name. */
  async getSheet(
    tenantId: string,
    sheetId: string,
  ): Promise<{ _id: string; name: string; topicId: string } | null> {
    const sheet = await this.sheetModel
      .findOne({ _id: sheetId, tenantId })
      .lean()
      .exec();
    return sheet
      ? { _id: sheet._id.toString(), name: sheet.name, topicId: sheet.topicId }
      : null;
  }

  /**
   * How many of these pointers actually render, and how many silently don't.
   *
   * Asset counts have to be derived from this rather than from a `count()` on
   * gallery_assets: a pointer is only a reference, and resolveAssets drops any
   * whose source is rejected, deleted, or has no URL yet. Counting rows counts
   * things the grid will never show, which reads to the operator as assets
   * having gone missing.
   */
  private async countVisible(
    pointers: any[],
  ): Promise<{ visible: Set<string>; hiddenBySheet: Map<string, number> }> {
    const resolved = await this.resolveAssets(pointers);
    const visible = new Set(resolved.map(r => r._id));
    const hiddenBySheet = new Map<string, number>();
    for (const p of pointers) {
      if (visible.has(p._id.toString())) continue;
      hiddenBySheet.set(p.sheetId, (hiddenBySheet.get(p.sheetId) ?? 0) + 1);
    }
    return { visible, hiddenBySheet };
  }

  private async resolveAssets(assets: GalleryAssetDocument[] | any[]): Promise<ResolvedGalleryAsset[]> {
    if (assets.length === 0) return [];
    const packageIds = [...new Set(assets.map(a => a.sourcePackageId))];
    // Only the three arrays this method reads — packages carry large copy/debate
    // fields that counting paths would otherwise pull for every asset.
    const packages = await this.packageModel
      .find({ _id: { $in: packageIds } })
      .select('images video videos carouselCards')
      .lean()
      .exec();
    const packageById = new Map(packages.map(p => [p._id.toString(), p]));

    const resolved: ResolvedGalleryAsset[] = [];
    for (const asset of assets) {
      const pkg = packageById.get(asset.sourcePackageId);
      if (!pkg) continue; // source package deleted — silently drop, no reconciliation needed

      let assetUrl = '';
      let aspectRatio: string | undefined;
      let resolution: string | undefined;
      let sizes: ResolvedGalleryAsset['sizes'];

      if (asset.assetType === 'image') {
        // A variant can hold several entries: the real creative, derived
        // placement sizes appended by ImageResizerService, and ready-made
        // sizes uploaded next to it. Resolve the creative EXPLICITLY as the
        // one that is neither — picking the array's first match happens to
        // work only because sizes are appended, which is an ordering
        // accident, and getting it wrong would show a blur-margined
        // derivative (or an off-ratio cut) as though it were the creative.
        const forVariant = (pkg.images ?? []).filter((i: any) => i.variantIndex === asset.variantIndex && i.imageUrl);
        const isAlternateSize = (i: any) => !!i.extendedFrom || !!i.uploadedSizeOf;
        const img = forVariant.find((i: any) => !isAlternateSize(i)) ?? forVariant[0];
        if (!img?.imageUrl || img.rejected) continue; // rejected — hidden from its sheet until restored, pointer untouched
        assetUrl = img.imageUrl;
        aspectRatio = img.aspectRatio;
        resolution = img.resolution;
        // Alternate sizes ride along on the one row rather than becoming rows
        // of their own. They inherit the creative's rejected state implicitly:
        // the `continue` above drops the whole asset when its source is
        // rejected, sizes included.
        const alternates = forVariant.filter((i: any) => i !== img && isAlternateSize(i));
        if (alternates.length) {
          sizes = alternates.map((i: any) => ({
            imageUrl: i.imageUrl,
            aspectRatio: i.aspectRatio,
            width: i.width,
            height: i.height,
            // Canvas-extended by us vs. supplied ready-made — the first has a
            // blurred margin, the second is a real cut, and a viewer choosing
            // an asset for a placement wants to know which.
            derived: !!i.extendedFrom,
          }));
        }
      } else if (asset.assetType === 'video') {
        if (!pkg.video?.videoUrl || pkg.video.rejected) continue;
        assetUrl = pkg.video.videoUrl;
        aspectRatio = pkg.video.aspectRatio;
        resolution = pkg.video.resolution;
        // `videos[]` holds every size INCLUDING the primary (see
        // campaign-creator.service.ts) — exclude whichever entry matches the
        // primary so it isn't listed as its own alternate. Same "primary
        // carries the reject state, sizes ride along on one row" model as
        // images: the `continue` above already dropped the whole asset if
        // pkg.video is rejected, sizes included.
        const primaryVideoUrl = pkg.video.videoUrl;
        const videoAlternates = (pkg.videos ?? []).filter(
          (v: any) => v.variantIndex === asset.variantIndex && v.videoUrl && v.videoUrl !== primaryVideoUrl,
        );
        if (videoAlternates.length) {
          sizes = videoAlternates.map((v: any) => ({
            imageUrl: v.videoUrl,
            aspectRatio: v.aspectRatio,
            derived: false,
          }));
        }
      } else {
        const card = (pkg.carouselCards ?? []).find((c: any) => c.slotIndex === asset.variantIndex);
        if (!card?.imageUrl) continue;
        assetUrl = card.imageUrl;
      }

      resolved.push({
        _id: asset._id.toString(),
        assetType: asset.assetType,
        variantIndex: asset.variantIndex,
        sourcePackageId: asset.sourcePackageId,
        assetUrl,
        aspectRatio,
        resolution,
        ...(sizes ? { sizes } : {}),
      });
    }
    return resolved;
  }

  async moveAsset(tenantId: string, assetId: string, targetSheetId: string) {
    const [asset, targetSheet] = await Promise.all([
      this.assetModel.findOne({ _id: assetId, tenantId }).exec(),
      this.sheetModel.findOne({ _id: targetSheetId, tenantId }).lean().exec(),
    ]);
    if (!asset) throw new NotFoundException(`Gallery asset ${assetId} not found`);
    if (!targetSheet) throw new NotFoundException(`Gallery sheet ${targetSheetId} not found`);
    asset.sheetId = targetSheetId;
    await asset.save();
    return { _id: asset._id.toString(), sheetId: asset.sheetId };
  }

  /** Bulk version of moveAsset — same semantics, one query instead of N. */
  async moveAssets(tenantId: string, assetIds: string[], targetSheetId: string) {
    const targetSheet = await this.sheetModel.findOne({ _id: targetSheetId, tenantId }).lean().exec();
    if (!targetSheet) throw new NotFoundException(`Gallery sheet ${targetSheetId} not found`);
    const result = await this.assetModel.updateMany(
      { _id: { $in: assetIds }, tenantId },
      { $set: { sheetId: targetSheetId } },
    );
    return { movedCount: result.modifiedCount, sheetId: targetSheetId };
  }

  /**
   * Files existing creatives (picked from the whole Creatives library, not
   * just already-tracked GalleryAssets) directly into a sheet — powers the
   * Gallery's "Add creative" -> pick-from-existing bottom sheet. Each item
   * identifies one image variant / the video / one carousel card on an
   * already-completed CreativePackage. Some packages predate the Gallery
   * feature (or their auto-populate call failed) and so have NO GalleryAsset
   * pointer anywhere yet — those get a brand new pointer created directly in
   * the target sheet. Ones that already have a pointer elsewhere get that
   * pointer's sheetId updated instead (same effect as a move), so an asset
   * is never tracked twice.
   */
  async addExistingAssets(
    tenantId: string,
    targetSheetId: string,
    items: Array<{ sourcePackageId: string; assetType: GalleryAssetType; variantIndex: number }>,
  ) {
    const targetSheet = await this.sheetModel.findOne({ _id: targetSheetId, tenantId }).lean().exec();
    if (!targetSheet) throw new NotFoundException(`Gallery sheet ${targetSheetId} not found`);

    let addedCount = 0;
    let movedCount = 0;
    for (const item of items) {
      const existing = await this.assetModel.findOne({
        tenantId,
        sourcePackageId: item.sourcePackageId,
        assetType: item.assetType,
        variantIndex: item.variantIndex,
      }).exec();
      if (existing) {
        if (existing.sheetId !== targetSheetId) {
          existing.sheetId = targetSheetId;
          await existing.save();
          movedCount++;
        }
      } else {
        await this.assetModel.create({
          tenantId,
          sheetId: targetSheetId,
          assetType: item.assetType,
          sourcePackageId: item.sourcePackageId,
          variantIndex: item.variantIndex,
        });
        addedCount++;
      }
    }
    this.logger.log(`Existing creatives filed into sheet: tenantId=${tenantId} sheetId=${targetSheetId} added=${addedCount} movedExisting=${movedCount}`);
    return { addedCount, movedCount };
  }

  /** Powers the "in gallery: Topic / Sheet" line on the package detail page. */
  async getPackageAssetLocations(tenantId: string, packageId: string) {
    const assets = await this.assetModel.find({ tenantId, sourcePackageId: packageId }).lean().exec();
    if (assets.length === 0) return {};
    const sheetIds = [...new Set(assets.map(a => a.sheetId))];
    const sheets = await this.sheetModel.find({ _id: { $in: sheetIds } }).lean().exec();
    const sheetById = new Map(sheets.map(s => [s._id.toString(), s]));
    const topicIds = [...new Set(sheets.map(s => s.topicId))];
    const topics = await this.topicModel.find({ _id: { $in: topicIds } }).lean().exec();
    const topicById = new Map(topics.map(t => [t._id.toString(), t]));
    const pkg = await this.packageModel.findOne({ _id: packageId, tenantId }).lean().exec();

    const result: Record<string, { topicId: string; topicName: string; sheetId: string; sheetName: string; rejected: boolean }> = {};
    for (const asset of assets) {
      const sheet = sheetById.get(asset.sheetId);
      if (!sheet) continue;
      const topic = topicById.get(sheet.topicId);
      if (!topic) continue;
      const rejected = asset.assetType === 'video'
        ? !!(pkg as any)?.video?.rejected
        : !!(pkg as any)?.images?.find((i: any) => i.variantIndex === asset.variantIndex)?.rejected;
      result[`${asset.assetType}-${asset.variantIndex}`] = {
        topicId: topic._id.toString(),
        topicName: topic.name,
        sheetId: sheet._id.toString(),
        sheetName: sheet.name,
        rejected,
      };
    }
    return result;
  }

  /** Bulk-deletes GalleryAsset pointers only — the source CreativePackage is never touched. */
  async removeAssets(tenantId: string, assetIds: string[]) {
    const result = await this.assetModel.deleteMany({ _id: { $in: assetIds }, tenantId });
    return { removedCount: result.deletedCount };
  }

  /**
   * Bulk-reject by gallery-asset-id — resolves each to its source package
   * and sets `rejected: true` there (same effect as
   * CreativeController.rejectAsset, just reachable from the Gallery's
   * selection bar which only has GalleryAsset ids, possibly spanning
   * several different source packages in one call).
   */
  async rejectAssets(tenantId: string, assetIds: string[]) {
    const assets = await this.assetModel.find({ _id: { $in: assetIds }, tenantId }).lean().exec();
    let rejectedCount = 0;
    for (const asset of assets) {
      const pkg = await this.packageModel.findOne({ _id: asset.sourcePackageId, tenantId }).exec();
      if (!pkg) continue;
      if (asset.assetType === 'video') {
        if (!pkg.video) continue;
        await this.packageModel.updateOne({ _id: pkg._id, tenantId }, { $set: { 'video.rejected': true } });
        rejectedCount++;
      } else if (asset.assetType === 'image') {
        const images = [...(pkg.images ?? [])];
        const idx = images.findIndex((i: any) => i.variantIndex === asset.variantIndex);
        if (idx < 0) continue;
        images[idx] = { ...images[idx], rejected: true } as any;
        await this.packageModel.updateOne({ _id: pkg._id, tenantId }, { $set: { images } });
        rejectedCount++;
      }
    }
    return { rejectedCount };
  }

  /** Cascade-deletes a sheet's GalleryAssets, then the sheet. Source packages are never touched. */
  async deleteSheet(tenantId: string, sheetId: string) {
    const sheet = await this.sheetModel.findOne({ _id: sheetId, tenantId }).lean().exec();
    if (!sheet) throw new NotFoundException(`Gallery sheet ${sheetId} not found`);
    await this.assetModel.deleteMany({ tenantId, sheetId });
    await this.sheetModel.deleteOne({ _id: sheetId, tenantId });
    return { _id: sheetId };
  }

  /** Cascade-deletes every sheet in a topic (and their assets), then the topic. */
  async deleteTopic(tenantId: string, topicId: string) {
    const topic = await this.topicModel.findOne({ _id: topicId, tenantId }).lean().exec();
    if (!topic) throw new NotFoundException(`Gallery topic ${topicId} not found`);
    const sheets = await this.sheetModel.find({ tenantId, topicId }).lean().exec();
    const sheetIds = sheets.map(s => s._id.toString());
    await this.assetModel.deleteMany({ tenantId, sheetId: { $in: sheetIds } });
    await this.sheetModel.deleteMany({ tenantId, topicId });
    await this.topicModel.deleteOne({ _id: topicId, tenantId });
    return { _id: topicId };
  }
}
