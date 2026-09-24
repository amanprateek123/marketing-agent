/**
 * Serving a creative's picture to the console.
 *
 * The brain stores an `image_url` that looks public and is not. Every one of them 403s to a
 * browser (verified 2026-09-19 against both buckets), so the console cannot render them directly;
 * and the two buckets belong to two different AWS accounts, so there is no single credential that
 * reads all of them either. This service is the one place that knows which key opens which bucket.
 *
 * It PRESIGNS rather than streams. Streaming would put every thumbnail's bytes through the API
 * process — a grid of twelve 2 MB creatives is 24 MB of Node heap and socket time per page view,
 * to deliver bytes S3 is better at delivering. A presigned URL costs one signature and hands the
 * transfer to S3. The redirect is short-lived and marked private so it is not cached as if it were
 * a permanent public asset.
 *
 * What it will not do: guess. An unrecognised bucket, an unset credential pair, or a key that is
 * not there all produce a 404, and the page draws its labelled placeholder. A creative whose
 * picture we cannot fetch is a known unknown, not a broken image.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** How long a thumbnail link stays good. Long enough to load a page, short enough not to leak. */
const LINK_TTL_SECONDS = 600;

interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

@Injectable()
export class CreativeImageService {
  private readonly logger = new Logger(CreativeImageService.name);
  private readonly region: string;
  /** Where `publish` puts world-readable copies, and the only prefix inside it that is public. */
  private readonly publicBucket: string;
  private readonly publicPrefix: string;
  private readonly credentialsByBucket = new Map<string, BucketCredentials>();
  private readonly clients = new Map<string, S3Client>();

  constructor(private readonly config: ConfigService) {
    this.region =
      this.config.get<string>('creativeImages.region') ?? 'ap-south-1';
    this.publicBucket =
      this.config.get<string>('creativeImages.astroBucket') ??
      '91astrology-common';
    this.publicPrefix =
      this.config.get<string>('creativeImages.publicPrefix') ??
      'marketing-creatives/';

    const register = (bucket: string | undefined, creds: BucketCredentials) => {
      // A bucket with no credentials is not registered at all, so `isConfigured` can answer
      // honestly and the caller can decide not to hand the browser a URL that will 404.
      if (!bucket || !creds.accessKeyId || !creds.secretAccessKey) return;
      this.credentialsByBucket.set(bucket, creds);
    };

    register(this.config.get<string>('creativeImages.primaryBucket'), {
      accessKeyId:
        this.config.get<string>('creativeImages.primaryAccessKeyId') ?? '',
      secretAccessKey:
        this.config.get<string>('creativeImages.primarySecretAccessKey') ?? '',
    });
    register(this.config.get<string>('creativeImages.astroBucket'), {
      accessKeyId:
        this.config.get<string>('creativeImages.astroAccessKeyId') ?? '',
      secretAccessKey:
        this.config.get<string>('creativeImages.astroSecretAccessKey') ?? '',
    });

    if (this.credentialsByBucket.size === 0) {
      this.logger.warn(
        'No creative-image credentials are set, so every creative will show its placeholder ' +
          'instead of its picture. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and/or ' +
          'ASTRO_AWS_ACCESS_KEY_ID/ASTRO_AWS_SECRET_ACCESS_KEY to turn thumbnails on.',
      );
    }
  }

  /**
   * Split an S3 https URL into bucket and key.
   *
   * Both host shapes appear in the brain's rows — `<bucket>.s3.<region>.amazonaws.com/<key>` and
   * the older `<bucket>.s3.amazonaws.com/<key>` — so both are handled. Anything else (a CDN, a
   * relative path, a URL from somewhere we do not hold keys for) returns null and is treated as
   * "no picture available" rather than being fetched blind.
   */
  parse(imageUrl: string | null): { bucket: string; key: string } | null {
    if (!imageUrl) return null;
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;

    const match = /^([^.]+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.exec(
      url.hostname,
    );
    if (!match) return null;

    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!key) return null;
    return { bucket: match[1], key };
  }

  /** True when this exact URL is one we hold a key for — i.e. worth showing an <img> at all. */
  canServe(imageUrl: string | null): boolean {
    const parsed = this.parse(imageUrl);
    return parsed !== null && this.credentialsByBucket.has(parsed.bucket);
  }

  /**
   * True when the object is world-readable and needs no signature at all.
   *
   * WHY THIS IS SEPARATE FROM `canServe`. A creative that has been through write-mcp's `publish`
   * lives in the astro bucket under the public prefix, and that tool says so in as many words:
   * "These URLs are permanent and unsigned." Six such creatives rendered as "Preview unavailable"
   * because this service would only emit an image it could SIGN, and signing needs credentials the
   * local harness does not have — so it hid pictures that required no credentials to see.
   *
   * The prefix matters, not just the bucket: 91astrology-common returns AccessDenied for objects
   * outside whatever its policy covers, which is the same trap `fetch_bytes` fell into on the
   * creativebot side by treating a routing answer as a permissions answer.
   */
  isPubliclyReadable(imageUrl: string | null): boolean {
    const parsed = this.parse(imageUrl);
    if (!parsed) return false;
    return (
      parsed.bucket === this.publicBucket &&
      parsed.key.startsWith(this.publicPrefix)
    );
  }

  /**
   * A short-lived, publicly-fetchable URL for one creative's picture.
   *
   * Throws NotFoundException rather than returning null: the caller is a controller answering a
   * browser's image request, and "we will not serve this" and "this does not exist" are the same
   * answer as far as an <img> is concerned.
   */
  async signedUrlFor(imageUrl: string | null): Promise<string> {
    const parsed = this.parse(imageUrl);
    if (!parsed) {
      throw new NotFoundException(
        'That creative has no picture stored in a bucket this console can read.',
      );
    }
    const creds = this.credentialsByBucket.get(parsed.bucket);
    if (!creds) {
      throw new NotFoundException(
        `No credentials are configured for bucket '${parsed.bucket}', so its pictures cannot be shown.`,
      );
    }

    let client = this.clients.get(parsed.bucket);
    if (!client) {
      client = new S3Client({ region: this.region, credentials: creds });
      this.clients.set(parsed.bucket, client);
    }

    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
        { expiresIn: LINK_TTL_SECONDS },
      );
    } catch (err) {
      // Signing is local and rarely fails, but if it does the honest answer is still "no picture".
      this.logger.warn(
        `Could not sign ${parsed.bucket}/${parsed.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new NotFoundException('That picture could not be prepared.');
    }
  }
}
