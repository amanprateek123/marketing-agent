import { Controller, Get, Post, Patch, Delete, Param, Body, BadRequestException } from '@nestjs/common';
import { GalleryService } from './gallery.service';

@Controller('gallery')
export class GalleryController {
  constructor(private readonly galleryService: GalleryService) {}

  @Get(':tenantId/topics')
  async listTopics(@Param('tenantId') tenantId: string) {
    return this.galleryService.listTopics(tenantId);
  }

  @Post(':tenantId/topics')
  async createTopic(@Param('tenantId') tenantId: string, @Body() body: { name?: string }) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.galleryService.createTopic(tenantId, name);
  }

  @Patch(':tenantId/topics/:topicId')
  async renameTopic(
    @Param('tenantId') tenantId: string,
    @Param('topicId') topicId: string,
    @Body() body: { name?: string },
  ) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.galleryService.renameTopic(tenantId, topicId, name);
  }

  @Get(':tenantId/topics/:topicId/sheets')
  async listSheets(@Param('tenantId') tenantId: string, @Param('topicId') topicId: string) {
    return this.galleryService.listSheets(tenantId, topicId);
  }

  @Post(':tenantId/topics/:topicId/sheets')
  async createSheet(
    @Param('tenantId') tenantId: string,
    @Param('topicId') topicId: string,
    @Body() body: { name?: string },
  ) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.galleryService.createSheet(tenantId, topicId, name);
  }

  /** Every Topic/Sheet pair for the tenant — powers the "move to" destination picker. */
  @Get(':tenantId/sheets')
  async listAllSheets(@Param('tenantId') tenantId: string) {
    return this.galleryService.listAllSheetsWithTopics(tenantId);
  }

  @Get(':tenantId/sheets/:sheetId/assets')
  async listSheetAssets(@Param('tenantId') tenantId: string, @Param('sheetId') sheetId: string) {
    return this.galleryService.listSheetAssets(tenantId, sheetId);
  }

  // Declared BEFORE :assetId below — a literal-segment route must come first
  // or the :assetId wildcard route (same segment count: 'assets', <param>)
  // silently swallows it, treating "move" as an assetId. See the NestJS
  // route-ordering gotcha noted elsewhere in this codebase.
  @Patch(':tenantId/assets/move')
  async moveAssets(
    @Param('tenantId') tenantId: string,
    @Body() body: { assetIds?: string[]; sheetId?: string },
  ) {
    if (!body.assetIds?.length) throw new BadRequestException('assetIds is required');
    if (!body.sheetId) throw new BadRequestException('sheetId is required');
    return this.galleryService.moveAssets(tenantId, body.assetIds, body.sheetId);
  }

  @Patch(':tenantId/assets/:assetId')
  async moveAsset(
    @Param('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
    @Body() body: { sheetId?: string },
  ) {
    if (!body.sheetId) throw new BadRequestException('sheetId is required');
    return this.galleryService.moveAsset(tenantId, assetId, body.sheetId);
  }

  /** Removes the GalleryAsset pointer only — the source CreativePackage is never touched. */
  @Post(':tenantId/assets/remove')
  async removeAssets(@Param('tenantId') tenantId: string, @Body() body: { assetIds?: string[] }) {
    if (!body.assetIds?.length) throw new BadRequestException('assetIds is required');
    return this.galleryService.removeAssets(tenantId, body.assetIds);
  }

  /** Bulk-reject (soft-delete, reversible) by gallery-asset-id — see GalleryService.rejectAssets. */
  @Post(':tenantId/assets/reject')
  async rejectAssets(@Param('tenantId') tenantId: string, @Body() body: { assetIds?: string[] }) {
    if (!body.assetIds?.length) throw new BadRequestException('assetIds is required');
    return this.galleryService.rejectAssets(tenantId, body.assetIds);
  }

  @Get(':tenantId/packages/:packageId/asset-locations')
  async getPackageAssetLocations(@Param('tenantId') tenantId: string, @Param('packageId') packageId: string) {
    return this.galleryService.getPackageAssetLocations(tenantId, packageId);
  }

  @Patch(':tenantId/sheets/:sheetId')
  async renameSheet(
    @Param('tenantId') tenantId: string,
    @Param('sheetId') sheetId: string,
    @Body() body: { name?: string },
  ) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    return this.galleryService.renameSheet(tenantId, sheetId, name);
  }

  @Delete(':tenantId/sheets/:sheetId')
  async deleteSheet(@Param('tenantId') tenantId: string, @Param('sheetId') sheetId: string) {
    return this.galleryService.deleteSheet(tenantId, sheetId);
  }

  @Delete(':tenantId/topics/:topicId')
  async deleteTopic(@Param('tenantId') tenantId: string, @Param('topicId') topicId: string) {
    return this.galleryService.deleteTopic(tenantId, topicId);
  }
}
