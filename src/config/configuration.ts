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
    /**
     * Presign media URLs in creative READ responses. Default OFF, which is
     * production behaviour: the production bucket is public-read, so the stored
     * URL already renders and signing would only add an expiry.
     *
     * Turn it on for a deployment whose bucket is PRIVATE — otherwise every
     * thumbnail 403s, since the dashboard renders them with a plain <img src>.
     *
     * Deliberately opt-in rather than always-on. A signed URL is a VIEW, but not
     * every consumer treats it as one: the gallery-to-campaign flow copies
     * `images[].imageUrl` out of a getCreativePackage response and persists it
     * into a manual campaign (campaigns/new/page.tsx), which would bake an
     * expiring link into a live Meta ad.
     */
    signMediaUrls: (process.env.S3_SIGN_MEDIA_URLS ?? '').toLowerCase() === 'true',
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
  foundry: {
    // Foundry's RUN api, as MCP over HTTP — not REST. This token may only RUN the agents it was
    // granted; it cannot edit or deploy anything, which is why it is safe to hold in this service.
    // Unset = every /brain/* route that needs a run 503s and the rest of the app is unaffected.
    url: process.env.FOUNDRY_RUN_MCP_URL ?? '',
    token: process.env.FOUNDRY_RUN_TOKEN ?? '',
    // Generous because an MCP call here starts or reads a run rather than waiting on one — a
    // Brain review takes minutes, and nothing in this bridge holds a request open for it.
    timeoutMs: parseInt(process.env.FOUNDRY_RUN_TIMEOUT_MS ?? '60000', 10),
  },
  brain: {
    // The 91astro brain's MCP server — the same URL and token the creative pipeline already uses,
    // so there is one credential for one server rather than two that can drift apart.
    url: process.env.BRAIN_MCP_URL ?? '',
    token: process.env.BRAIN_MCP_BEARER_TOKEN ?? '',
    timeoutMs: parseInt(process.env.BRAIN_MCP_TIMEOUT_MS ?? '30000', 10),
    /**
     * The Slack id a console gate decision is recorded under.
     *
     * The brain enforces `APPROVAL_SLACK_IDS` inside `approval_record` — a check in SQL that
     * nothing written in a Slack message can argue its way past. The dashboard has a real login,
     * but the brain cannot see it, so a decision made here still has to arrive carrying an identity
     * that allowlist knows. Held server-side; unset, gate decisions 503 with a message naming this
     * variable rather than failing upstream and leaving a gate that will not close.
     */
    approvalActorSlackId: process.env.BRAIN_APPROVAL_ACTOR_SLACK_ID ?? '',
  },
  ops: {
    // System-failure alert channel (pipeline deaths, creative failures, stale-data
    // audit skips, Slack delivery failures). Separate from tenant webhooks — this
    // is for whoever operates the system. Unset = alerts degrade to error logs.
    alertWebhook: process.env.OPS_ALERT_WEBHOOK ?? '',
  },
});
