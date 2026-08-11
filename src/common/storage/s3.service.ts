import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import axios from 'axios';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  /** See presignIfOwnBucket — OFF in production, on only for a private-bucket deployment. */
  private readonly signMediaUrls: boolean;

  constructor(private readonly configService: ConfigService) {
    this.region = this.configService.get<string>('aws.region') ?? 'ap-south-1';
    this.bucket = this.configService.get<string>('aws.s3Bucket') ?? '';
    this.signMediaUrls = this.configService.get<boolean>('aws.signMediaUrls') ?? false;
    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
    });
  }

  /**
   * Download a file from a URL and upload it to S3.
   * Returns the permanent public S3 URL.
   */
  async uploadFromUrl(url: string, key: string, contentType: string): Promise<string> {
    this.logger.log(`Downloading from URL for S3 upload: key=${key}`);

    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return this.uploadBuffer(Buffer.from(response.data), key, contentType);
  }

  /**
   * Upload an already-in-memory buffer (e.g. a locally-produced ffmpeg merge
   * output) to S3. Returns the permanent public S3 URL.
   */
  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));

    const s3Url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
    this.logger.log(`Uploaded to S3: ${s3Url}`);
    return s3Url;
  }

  /**
   * Turn one of OUR stored S3 URLs into a URL a browser can actually load.
   *
   * `uploadBuffer` PutObjects with no ACL and returns a bare
   * `https://<bucket>.s3.<region>.amazonaws.com/<key>`, which only renders when the bucket has a
   * public-read policy. That holds for the production bucket — so this is OFF by default and
   * production behaviour is unchanged. Switch `S3_SIGN_MEDIA_URLS=true` on a deployment whose
   * bucket is PRIVATE, where otherwise every thumbnail 403s.
   *
   * Opt-in rather than always-on for a specific reason: a signed URL is a VIEW, but not every
   * consumer treats it as one. The gallery-to-campaign flow copies `images[].imageUrl` out of a
   * getCreativePackage response and persists it into a manual campaign, which would bake an
   * expiring link into a live Meta ad.
   *
   * Deliberately narrow when it IS on:
   * - Only URLs in OUR configured bucket are touched. Anything else (a Higgsfield CDN link, an
   *   already-signed URL, a data URI) is returned byte-identical, so this can be applied to a
   *   whole document without auditing where each field came from.
   * - It signs a view. Stored documents are never rewritten, so the Meta upload in
   *   campaign-creator.service.ts, which reads the CreativePackage straight from Mongo, keeps
   *   seeing the durable URL.
   */
  async presignIfOwnBucket(url: string, expiresIn = 12 * 3600): Promise<string> {
    if (!this.signMediaUrls) return url;
    const key = this.ownBucketKey(url);
    if (!key) return url;
    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );
    } catch (err) {
      // A thumbnail is not worth failing a request over — fall back to the raw URL, which is
      // exactly what the caller would have got anyway.
      this.logger.warn(`presign failed for key=${key}: ${(err as Error).message}`);
      return url;
    }
  }

  /** The object key if `url` lives in our bucket and is not already signed, else null. */
  private ownBucketKey(url: string): string | null {
    if (!url || !this.bucket || !url.startsWith('https://')) return null;
    if (url.includes('X-Amz-Signature=')) return null; // already signed; re-signing would corrupt it
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // Both addressing styles our own code and the pipeline produce:
    //   <bucket>.s3.<region>.amazonaws.com/<key>   and   <bucket>.s3.amazonaws.com/<key>
    const host = parsed.hostname;
    if (host !== `${this.bucket}.s3.${this.region}.amazonaws.com` &&
        host !== `${this.bucket}.s3.amazonaws.com`) {
      return null;
    }
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return key || null;
  }
}
