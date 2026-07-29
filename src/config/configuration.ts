export default () => ({
  app: {
    port: parseInt(process.env.APP_PORT ?? '3000', 10),
    env: process.env.APP_ENV ?? 'development',
  },
  auth: {
    email: process.env.AUTH_EMAIL ?? '',
    password: process.env.AUTH_PASSWORD ?? '',
    jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
    // How long an issued token stays valid, in seconds. Plain seconds (not
    // a '7d'-style string) to avoid @nestjs/jwt's stricter expiresIn type
    // and keep the env value unambiguous. Default 604800 = 7 days —
    // single-operator dashboard, not worth forcing frequent re-logins for.
    tokenTtlSeconds: parseInt(
      process.env.AUTH_TOKEN_TTL_SECONDS ?? '604800',
      10,
    ),
  },
  mongo: {
    uri:
      process.env.MONGO_URI ??
      'mongodb://localhost:27017/autonomous-marketing-agent',
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
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
    chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.1',
  },
  imageGen: {
    // 'nano_banana' (Gemini Image) | 'gpt_image' (OpenAI gpt-image-*)
    provider: process.env.IMAGE_PROVIDER ?? 'nano_banana',
  },
  fal: {
    apiKey: process.env.FAL_API_KEY ?? '',
  },
  heygen: {
    apiKey: process.env.HEYGEN_API_KEY ?? '',
  },
  cartesia: {
    apiKey: process.env.CARTESIA_API_KEY ?? '',
    hindiVoiceId: process.env.CARTESIA_HINDI_VOICE_ID ?? '',
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY ?? '',
  },
  pipeline: {
    // The external creative pipeline (Slack-driven authoring + image generation),
    // running on its own box. Include the scheme and no trailing slash, e.g.
    // https://pipeline.example.com — the bridge appends /v1/... itself.
    // Unset = the Custom-brief path returns 503 and the rest of the app is
    // unaffected.
    url: process.env.PIPELINE_API_URL ?? '',
    // Shared bearer token. Held server-side only; never sent to the browser.
    token: process.env.PIPELINE_API_TOKEN ?? '',
    // Per-call HTTP timeout. Runs are asynchronous — every call here either
    // starts a run or polls it, so none of them waits on generation.
    timeoutMs: parseInt(process.env.PIPELINE_API_TIMEOUT_MS ?? '30000', 10),
  },
  ops: {
    // System-failure alert channel (pipeline deaths, creative failures, stale-data
    // audit skips, Slack delivery failures). Separate from tenant webhooks — this
    // is for whoever operates the system. Unset = alerts degrade to error logs.
    alertWebhook: process.env.OPS_ALERT_WEBHOOK ?? '',
  },
});
