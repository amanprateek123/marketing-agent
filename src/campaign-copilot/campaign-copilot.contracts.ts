export const CAMPAIGN_COPILOT_BUILD = 'campaign-copilot-build';

export enum CampaignCopilotSessionStatus {
  COLLECTING = 'collecting',
  READY = 'ready',
  BUILD_QUEUED = 'build_queued',
  BUILDING = 'building',
  PENDING_APPROVAL = 'pending_approval',
  FAILED = 'failed',
}

export type CampaignCopilotMessageRole = 'user' | 'assistant' | 'system';

export interface CampaignCopilotMessage {
  id: string;
  role: CampaignCopilotMessageRole;
  content: string;
  createdAt: Date;
}

export type CampaignCopilotProductMode = 'existing' | 'new';

export type CampaignCopilotObjective =
  | 'sales_purchase'
  | 'leads'
  | 'traffic'
  | 'engagement'
  | 'awareness'
  | 'reach'
  | 'app_promotion';

export type CampaignCopilotFunnelStage = 'cold' | 'warm' | 'hot';

export type CampaignCopilotAudienceType =
  | 'advantage_plus'
  | 'lookalike'
  | 'retarget'
  | 'custom';

export type CampaignCopilotCreativeFormat =
  | 'image'
  | 'video'
  | 'carousel'
  | 'meme';

export interface CampaignCopilotNewProduct {
  description: string | null;
  price: number | null;
  currency: string | null;
  conversionEvent: string | null;
  conversionValue: number | null;
  pixelId: string | null;
  customConversionId: string | null;
  pageId: string | null;
  metaAppId: string | null;
  metaAppStoreUrl: string | null;
}

export interface CampaignCopilotPlan {
  campaignName: string | null;
  productMode: CampaignCopilotProductMode | null;
  productName: string | null;
  landingUrl: string | null;
  newProduct: CampaignCopilotNewProduct | null;
  objective: CampaignCopilotObjective | null;
  /** Deterministically derived Meta ad-set delivery goal for this objective. */
  optimizationGoal: string | null;
  /** Effective launch configuration after product/tenant fallback resolution. */
  pageId: string | null;
  conversionEvent: string | null;
  conversionValue: number | null;
  /** Budget after deterministic safety clamping. */
  dailyBudget: number | null;
  /** Exact operator request before clamping, retained for an honest preview. */
  requestedDailyBudget: number | null;
  accountId: string | null;
  funnelStage: CampaignCopilotFunnelStage | null;
  audienceType: CampaignCopilotAudienceType | null;
  audienceName: string | null;
  metaAudienceId: string | null;
  targetSegment: string | null;
  geoLocations: string[];
  language: string | null;
  creativeFormat: CampaignCopilotCreativeFormat | null;
  appPlatform: 'iOS' | 'Android' | null;
  angle: string | null;
  keyMessage: string | null;
}

export interface CampaignCopilotBudgetRecommendation {
  dailyBudget: number;
  maxAllowed: number;
  rationale: string;
}

export interface CampaignCopilotAudienceRecommendation {
  type: CampaignCopilotAudienceType;
  name: string | null;
  metaAudienceId: string | null;
  targetSegment: string | null;
  funnelStage: CampaignCopilotFunnelStage;
  rationale: string;
}

export interface CampaignCopilotRecommendations {
  budget: CampaignCopilotBudgetRecommendation | null;
  audience: CampaignCopilotAudienceRecommendation | null;
  accountId: string | null;
  objective: CampaignCopilotObjective;
  creativeFormat: CampaignCopilotCreativeFormat;
}

export interface CampaignCopilotReadiness {
  ready: boolean;
  missingFields: string[];
  blockers: string[];
  warnings: string[];
}

export interface CampaignCopilotBuildState {
  jobId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  campaignId: string | null;
  creativeBriefId: string | null;
  creativePackageId: string | null;
  error: string | null;
}

export interface CampaignCopilotSessionResponse {
  tenantId: string;
  sessionId: string;
  status: CampaignCopilotSessionStatus;
  messages: CampaignCopilotMessage[];
  plan: CampaignCopilotPlan;
  recommendations: CampaignCopilotRecommendations;
  readiness: CampaignCopilotReadiness;
  build: CampaignCopilotBuildState | null;
  createdAt: Date;
  updatedAt: Date;
}

/** JSON shape requested from OpenAI for every conversation turn. */
export interface CampaignCopilotModelTurn {
  reply: string;
  planPatch?: Omit<Partial<CampaignCopilotPlan>, 'newProduct'> & {
    newProduct?: Partial<CampaignCopilotNewProduct> | null;
    useRecommendedBudget?: boolean;
    useRecommendedAudience?: boolean;
    useRecommendedAccount?: boolean;
    useRecommendedObjective?: boolean;
    useRecommendedCreativeFormat?: boolean;
  };
}

export interface CampaignCopilotBuildJob {
  tenantId: string;
  sessionId: string;
  confirmationHash: string;
}

export function emptyCampaignCopilotPlan(): CampaignCopilotPlan {
  return {
    campaignName: null,
    productMode: null,
    productName: null,
    landingUrl: null,
    newProduct: null,
    objective: null,
    optimizationGoal: null,
    pageId: null,
    conversionEvent: null,
    conversionValue: null,
    dailyBudget: null,
    requestedDailyBudget: null,
    accountId: null,
    funnelStage: null,
    audienceType: null,
    audienceName: null,
    metaAudienceId: null,
    targetSegment: null,
    geoLocations: [],
    language: null,
    creativeFormat: null,
    appPlatform: null,
    angle: null,
    keyMessage: null,
  };
}

export function emptyCampaignCopilotBuildState(): CampaignCopilotBuildState {
  return {
    jobId: null,
    startedAt: null,
    completedAt: null,
    campaignId: null,
    creativeBriefId: null,
    creativePackageId: null,
    error: null,
  };
}
