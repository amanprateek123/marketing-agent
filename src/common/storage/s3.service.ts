import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly configService: ConfigService) {
    this.region = this.configService.get<string>('aws.region') ?? 'ap-south-1';
    this.bucket = this.configService.get<string>('aws.s3Bucket') ?? '';
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
    const buffer = Buffer.from(response.data);

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
}
