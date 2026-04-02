export default () => ({
  app: {
    port: parseInt(process.env.APP_PORT ?? '3000', 10),
    env: process.env.APP_ENV ?? 'development',
  },
  mongo: {
    uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/autonomous-marketing-agent',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  meta: {
    accessToken: process.env.META_ADS_ACCESS_TOKEN ?? '',
    accountId: process.env.META_ADS_ACCOUNT_ID ?? '',
  },
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL ?? '',
    webhookSecret: process.env.N8N_WEBHOOK_SECRET ?? '',
  },
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    s3Bucket: process.env.AWS_S3_BUCKET ?? '',
    region: process.env.AWS_REGION ?? 'ap-south-1',
  },
  google: {
    aiApiKey: process.env.GOOGLE_AI_API_KEY ?? '',
  },
  fal: {
    apiKey: process.env.FAL_API_KEY ?? '',
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY ?? '',
  },
});
