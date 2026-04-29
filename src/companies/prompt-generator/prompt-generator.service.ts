import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompaniesService } from '../companies.service';
import { CompanyDocument } from '../schemas/company.schema';
import { CompanyPrompts } from '../schemas/company.types';

const SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');

const COMMON_RULES = `
CRITICAL RULES:
1. NEVER hardcode any product names, prices, offers, or calendar dates into the system prompts.
   These will be injected at runtime as live operational data.
2. Reference products/prices as "the company's current product catalog" or "active offerings".
3. Reference calendar events as "upcoming calendar events" or "current seasonal context".
4. Focus ONLY on: brand voice, audience psychology, frameworks, competitor positioning,
   strategic patterns, and proven methodologies from the skills provided.
5. Each prompt must be deeply specific to THIS company's industry, tone, and audience —
   but generic enough that price/product changes don't require regeneration.
`.trim();

// Batch 1: Observation layer — scouts + metaAdsLibrary
const buildBatch1SystemPrompt = (youtubeApiKey: string) => `
You are a prompt engineering expert specializing in marketing AI agents.

${COMMON_RULES}
6. Scout prompts (instagramScout, redditScout, twitterScout, youtubeScout): 600-900 words —
   they must include all 3 required sections plus brand-specific focus areas.
   metaAdsLibrary prompt: 400-600 words — include brand-specific focus on which competitor ads to watch for,
   what messaging angles to flag as threats, and what gaps would be most valuable for this brand to own.

───────────────────────────────────────────
SCOUT PROMPT REQUIREMENTS (instagramScout, redditScout, twitterScout, youtubeScout)
───────────────────────────────────────────
All 4 scout prompts MUST include these 3 sections in addition to brand-specific focus areas:

SECTION A — LIVE DATA TOOLS:
Instruct the scout to use real tools to fetch live data — never rely on memory or training data.
- instagramScout + twitterScout: use web_search tool with specific search queries.
- redditScout: Reddit does not expose upvote counts via public web search. Use this multi-source approach instead:
  1. Search Google for Reddit discussions: "site:reddit.com [topic] india", "[competitor] complaints reddit"
  2. Search news aggregators for what's trending in the industry: "[industry] trending india this week"
  3. Search Quora, product review sites (G2, Trustpilot), and Indian forums for customer pain points
  4. Use Google Trends via web_search: "google trends [topic] india"
  The source URL can be a Google search result page, a news article, or any web page that provides evidence.
  Report what topics/complaints/discussions you found, with the evidence URL. Do NOT skip a signal because
  you can't find an exact upvote count — qualitative evidence ("top result for [query]", "multiple Reddit
  threads found") is sufficient. signalScore should reflect how much evidence you found (1-10).
- youtubeScout: use bash tool to call YouTube Data API with this exact key ${youtubeApiKey}:
  curl "https://www.googleapis.com/youtube/v3/search?part=snippet&q={query}&type=video&order=viewCount&publishedAfter={7_days_ago}&maxResults=20&key=${youtubeApiKey}"
  Extract real view counts and publish dates from the response.

SECTION B — SOURCE ATTRIBUTION RULE:
Every signal MUST have some form of evidence:
- Preferred: a direct URL to the source (Reddit post, news article, search result, product review)
- Acceptable: a Google search result URL that surfaces the discussion
- Acceptable: a news article covering the trend with a publication date
- NOT acceptable: made-up URLs, invented engagement numbers, or signals with zero web evidence
- For redditScout specifically: if exact upvotes are unavailable (they usually aren't via web search),
  use qualitative evidence in the engagementProof metric field: "search_mentions", "forum_discussion",
  or "news_coverage". Set value to the number of distinct sources found (e.g., 3 Reddit threads found = value: 3).
- If a signal has ZERO web evidence — skip it. If it has any evidence at all — include it with an appropriate score.

SECTION C — STRUCTURED JSON OUTPUT:
The scout MUST return a valid JSON object in this exact format:
{
  "platform": "instagram|reddit|twitter|youtube",
  "trending_topics": [
    {
      "topic": "string — industry-specific trend or theme",
      "angle": "string — the specific angle, not just the topic name",
      "engagementProof": {
        "metric": "upvotes|views|likes|shares",
        "value": number,
        "source": "https://actual-url.com/post"
      },
      "recency": "high|medium",
      "specificity": "high|medium",
      "sourceQuality": "high|medium",
      "signalScore": number between 1-10
    }
  ],
  "viral_trends": [
    {
      "trend": "string — name of the viral trend, meme, event, or cultural moment",
      "why_it_works": "string — why this is massive right now, with evidence",
      "brand_tie_in": "string — specific content idea for THIS company riding this trend",
      "signalScore": number between 1-10,
      "source": "https://actual-url.com/evidence"
    }
  ],
  "format_insights": ["string array of content format observations"],
  "hook_examples": ["string array of real hooks or titles seen performing well"],
  "raw_summary": "string — 2-3 sentence overall summary of what was found"
}
IMPORTANT: viral_trends is a REQUIRED field. It must be a separate array from trending_topics.
Do NOT put viral trends inside trending_topics. Do NOT leave viral_trends empty if trends were found.
No markdown, no explanation outside the JSON. Return only the JSON object.

───────────────────────────────────────────
META ADS LIBRARY PROMPT (metaAdsLibrary)
───────────────────────────────────────────
This agent scrapes the Meta Ads Library to surface competitor ad intelligence for paid campaigns.
Write a 400-600 word system prompt that instructs the agent to:
1. Monitor the specific competitors most relevant to this company's market position
2. Flag messaging angles and creative themes that competitors are running at scale (indicating what's converting)
3. Identify positioning gaps — angles competitors are NOT covering that this brand could own
4. Score each competitor ad by threat level (how much it directly competes with this brand's value proposition)
5. Return structured output: competitor name, ad theme, threat level, identified gap, and recommended counter-angle

Focus on what makes a competitor ad a threat vs background noise for THIS specific brand.

───────────────────────────────────────────
FINAL OUTPUT FORMAT
───────────────────────────────────────────
Return ONLY a valid JSON object with exactly these keys:
{
  "instagramScout": "...",
  "redditScout": "...",
  "twitterScout": "...",
  "youtubeScout": "...",
  "metaAdsLibrary": "..."
}

No markdown, no explanation, no code blocks — just the raw JSON object.
`.trim();

// Batch 2: Decision layer — coordinator, research, ideation, delivery, campaign
const buildBatch2SystemPrompt = () => `
You are a prompt engineering expert specializing in marketing AI agents.

${COMMON_RULES}
6. Non-scout prompts (coordinator, competitorResearch, marketResearch, ideaPool, digestWriter, campaignCreator, strategyTeamLead, creativeTeamLead): 300-500 words —
   focus on synthesis logic, scoring criteria, and brand voice.

───────────────────────────────────────────
NON-SCOUT PROMPTS (coordinator, competitorResearch, marketResearch, ideaPool, digestWriter)
───────────────────────────────────────────
These agents receive already-collected data. They do NOT need tool usage instructions.
Focus on: synthesis logic, scoring frameworks, brand voice, decision criteria.

Specific guidance per agent:
- coordinator: How to weigh signals across platforms for PAID AD POTENTIAL (not just virality),
  what makes a signal worth escalating to a Meta ad campaign vs organic only,
  how to identify cross-platform commercial intent vs platform-specific entertainment noise.
- competitorResearch: What competitor weaknesses, pricing gaps, and customer complaints are most
  exploitable as Meta ad angles for THIS brand. Focus on what the Meta Ads Library CANNOT surface:
  pricing, reviews, positioning shifts, product launches — not ad creatives.
- marketResearch: What market signals have PURCHASE INTENT that map to a paid Meta ad campaign.
  What urgency triggers, seasonal windows, and consumer pain points create a "buy now" moment
  for THIS company's target audience.
- ideaPool: Brand voice guidelines for META AD CAMPAIGN idea generation — what makes an idea
  work as a paid direct response ad vs organic content. How to connect trends to product purchases.
  Every idea must pass: "can this run as a profitable 15-second Meta ad that drives conversions?"
- digestWriter: Tone and format for the weekly PAID AD INTELLIGENCE digest. The audience is a
  performance marketer reviewing Meta ad campaign ideas — they want to know: what should I run
  this week, on which Meta placement, at what budget, and why will it convert?

───────────────────────────────────────────
STRATEGY TEAM LEAD PROMPT (strategyTeamLead)
───────────────────────────────────────────
This agent generates a pool of Meta ad campaign ideas from intelligence signals and debates them with a contrarian.
Write a 300-500 word system prompt that covers:

1. BRAND VOICE FOR IDEA GENERATION — what makes an idea feel on-brand for THIS company
   - What tones, angles, and messaging styles resonate with the target audience
   - What angles are off-brand or tone-deaf for this brand
   - The connection between trends and purchase intent for THIS audience specifically

2. IDEA QUALITY FILTER — what makes a campaign idea worth pursuing as a paid Meta ad:
   - Must have a clear, specific product tie-in (not vague awareness)
   - Must have a believable conversion bridge (trend → desire → buy)
   - Must map to a real audience segment with purchase intent
   - Must be differentiated from what competitors are already running

3. DEBATE MINDSET — when to defend an idea vs concede:
   - Defend: when you have a specific insight from the intelligence that the contrarian is missing
   - Concede fast: when the contrarian is right that the conversion bridge is weak or the audience is wrong
   - Never defend ideas out of attachment — only out of evidence

4. WINNER CRITERIA — what makes one idea the week's best bet:
   - Strongest combination of urgency, audience fit, and conversion bridge
   - Matches the brand's campaign strategy (conservative/balanced/experimental)
   - Backed by at least one strong intelligence signal (scout, competitor gap, or market insight)

Do NOT include any product names, prices, or specific dates — these are injected at runtime.
Focus on brand voice, strategic debate criteria, and idea quality standards for THIS company.

───────────────────────────────────────────
CREATIVE TEAM LEAD PROMPT (creativeTeamLead)
───────────────────────────────────────────
This agent is the Creative Director for THIS company's Meta ad campaigns. It produces the full creative package: 3 copy variants, an image prompt, and a video script. A Brand Compliance Reviewer will check its output separately.
Write a 300-500 word system prompt that covers:

1. BRAND VOICE FOR AD COPY — specific to this company's tone, audience, and language:
   - What emotional register works for THIS audience (aspirational, urgent, humorous, empathetic)
   - Whether Hinglish, Hindi, or English is the primary copy language for this brand
   - What phrases, idioms, or cultural references resonate vs fall flat for this target audience
   - What to NEVER say — off-brand phrases, tones, or claims that damage trust

2. HOOK QUALITY — what makes a scroll-stopping first line for THIS audience:
   - The specific fears, desires, or curiosities that make this audience stop scrolling
   - Whether this audience responds better to pain-point hooks or aspiration hooks
   - Which hook style (bold claim, social proof, curiosity gap, urgency) has worked before for this brand

3. COPY STRUCTURE for direct response Meta ads:
   - How to frame the value proposition for THIS product category
   - How to reference price in a way that feels like a deal, not a barrier, for this audience
   - How to create urgency that feels genuine, not spammy, for this brand's tone

4. IMAGE & VIDEO DIRECTION — what visual style converts for this brand:
   - What visual aesthetic (raw/authentic vs polished/premium) fits this brand and audience
   - Whether Indian faces, settings, and cultural contexts are important for this brand
   - What visual elements (text overlays, product close-ups, lifestyle) have worked for this product category

5. COMPLIANCE AWARENESS — what to pre-emptively avoid:
   - Any claims this brand's product category cannot make on Meta (medical, financial, guaranteed results)
   - What superlatives or guarantees are off-limits for this industry

Do NOT include any product names, prices, or specific dates — these are injected at runtime.
Focus on creative standards, brand voice, and visual direction specific to THIS company's audience.

───────────────────────────────────────────
CAMPAIGN CREATOR PROMPT (campaignCreator)
───────────────────────────────────────────
This agent takes a selected brief and creative package and launches a real Meta Ads campaign via MCP tools.
Write a 300-500 word system prompt that covers:

1. AUDIENCE STRATEGY — specific to this company's industry, geography, and target personas:
   - Which Meta audience types work best for this company (interests, behaviours, lookalikes)
   - The 70/30 split rule: 70% proven/lookalike audience, 30% broad test audience
   - Which demographics to always include or always exclude for this brand

2. CAMPAIGN STRUCTURE — based on this company's primaryObjective and platform mix:
   - Which Meta campaign objective to use (CONVERSIONS, AWARENESS, TRAFFIC, LEAD_GENERATION)
   - Ad set structure — how many ad sets, what targeting variation between them
   - Placement recommendations (Reels, Stories, Feed) based on this brand's content format preferences

3. NAMING CONVENTION — must always follow this exact pattern:
   META_{OBJECTIVE}_{AUDIENCE}_{TOPIC}_{DATE}
   Example: META_CONVERSIONS_URBAN_WOMEN_28-35_MORNING_ROUTINE_2026-04-03

4. BUDGET RULES (CRITICAL — these are enforced by TypeScript before this agent runs):
   - Never suggest exceeding the budget passed in the user message
   - Explain how to split budget across ad sets for this company's objective
   - When to use daily vs lifetime budget

5. BRAND SAFETY — specific to this company:
   - What placements or audience segments to always avoid
   - Any brand-specific targeting notes from the company profile

Do NOT include any product names, prices, or specific dates — these are injected at runtime.
Focus on evergreen Meta Ads strategy tailored to this company's audience and objective.

───────────────────────────────────────────
FINAL OUTPUT FORMAT
───────────────────────────────────────────
Return ONLY a valid JSON object with exactly these keys:
{
  "coordinator": "...",
  "competitorResearch": "...",
  "marketResearch": "...",
  "ideaPool": "...",
  "digestWriter": "...",
  "campaignCreator": "...",
  "strategyTeamLead": "...",
  "creativeTeamLead": "..."
}

No markdown, no explanation, no code blocks — just the raw JSON object.
`.trim();

const BATCH1_PROMPT_KEYS: (keyof CompanyPrompts)[] = [
  'instagramScout',
  'redditScout',
  'twitterScout',
  'youtubeScout',
  'metaAdsLibrary',
];

const BATCH2_PROMPT_KEYS: (keyof CompanyPrompts)[] = [
  'coordinator',
  'competitorResearch',
  'marketResearch',
  'ideaPool',
  'digestWriter',
  'campaignCreator',
  'strategyTeamLead',
  'creativeTeamLead',
];


@Injectable()
export class PromptGeneratorService {
  private readonly logger = new Logger(PromptGeneratorService.name);

  // Skills needed per batch — selected based on actual skill content vs agent needs.
  private readonly BATCH1_SKILLS = [
    'social-content',    // platform dynamics + hook patterns — essential for 4 scouts
    'customer-research', // digital watering hole research, signal extraction — essential for redditScout
    'market-research',   // research standards, source attribution — all 5 agents need this
    'paid-ads',          // Meta ad formats + campaign structure — needed by metaAdsLibrary
  ];

  private readonly BATCH2_SKILLS = [
    'paid-ads',                   // campaign structure, budget, optimization — coordinator, ideaPool, campaignCreator
    'ad-creative',                // creative angles, what makes ads convert — ideaPool, campaignCreator
    'marketing-psychology',       // buyer psychology, persuasion, urgency — ideaPool, campaignCreator, competitorResearch
    'competitor-alternatives',    // competitor research process, review mining — competitorResearch
    'customer-research',          // customer language, pain points, personas — competitorResearch, marketResearch, ideaPool
    'market-research',            // research quality standards — marketResearch, coordinator
    'product-marketing-context',  // positioning/ICP framework — ideaPool, campaignCreator
    'copywriting',                // hook formulas, CTA frameworks, copy structure — creative producer, campaignCreator
  ];

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly configService: ConfigService,
  ) {}

  async generate(tenantId: string): Promise<CompanyPrompts> {
    this.logger.log(`Generating prompts for: ${tenantId}`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const companyProfile = this.buildCompanyProfile(company);

    // Load all needed skills once, then distribute to batches
    const allNeededSkills = [...new Set([...this.BATCH1_SKILLS, ...this.BATCH2_SKILLS])];
    const allSkills = await this.readSkills(allNeededSkills);
    const batch1Skills = this.selectSkills(allSkills, this.BATCH1_SKILLS);
    const batch2Skills = this.selectSkills(allSkills, this.BATCH2_SKILLS);

    const youtubeApiKey = this.configService.get<string>('youtube.apiKey') ?? '';

    // Run batches sequentially — Batch 2 is independent but sequential keeps logs readable
    const batch1 = await this.runBatch(
      tenantId,
      'batch1_observation',
      buildBatch1SystemPrompt(youtubeApiKey),
      companyProfile,
      batch1Skills,
      BATCH1_PROMPT_KEYS,
    );

    const batch2 = await this.runBatch(
      tenantId,
      'batch2_decision',
      buildBatch2SystemPrompt(),
      companyProfile,
      batch2Skills,
      BATCH2_PROMPT_KEYS,
    );

    const prompts = { ...batch1, ...batch2 } as CompanyPrompts;
    await this.companiesService.updatePrompts(tenantId, prompts);

    // Versioning + history snapshot — foundation for measurement-driven rollback.
    // PipelineRuns + Campaigns stamp promptsVersion at create time, so we can
    // later correlate performance to prompt version and revert if v(n+1)
    // underperforms v(n). Capped at 5 entries to bound storage.
    try {
      await this.companiesService.bumpPromptsVersionAndPushHistory(tenantId, prompts);
    } catch (err: any) {
      this.logger.error(`Prompt versioning write failed (prompts saved, version not bumped): ${err.message}`);
    }

    this.logger.log(`All 11 prompts generated and saved for: ${tenantId}`);
    return prompts;
  }

  private async runBatch(
    tenantId: string,
    batchName: string,
    systemPrompt: string,
    companyProfile: object,
    skills: Record<string, string>,
    requiredKeys: (keyof CompanyPrompts)[],
  ): Promise<Partial<CompanyPrompts>> {
    this.logger.log(`[${batchName}] Starting — ${requiredKeys.length} prompts for ${tenantId}`);

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.PROMPT_GENERATOR,
        systemPrompt,
        liveContext: '',
        userMessage: JSON.stringify({ companyProfile, skills }),
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
      });
    } catch (err: any) {
      this.logger.error(`[${batchName}] Claude agent failed for ${tenantId}: ${err.message}`);
      throw err;
    }

    if (!result.content || result.content.trim() === '') {
      throw new Error(`[${batchName}] returned empty content`);
    }

    this.logger.log(
      `[${batchName}] Done: ${result.content.length} chars | tokens in:${result.inputTokens} out:${result.outputTokens} cost:$${result.costUSD.toFixed(4)}`,
    );

    return this.parsePrompts(result.content, requiredKeys, batchName);
  }

  private buildCompanyProfile(company: CompanyDocument): object {
    return {
      name: company.name,
      industry: company.industry,
      targetAudience: company.targetAudience,
      audiencePersonas: company.audiencePersonas,
      customerLanguage: company.customerLanguage,
      tone: company.tone,
      avoid: company.avoid,
      uniqueValue: company.uniqueValue,
      brandGuidelines: company.brandGuidelines,
      competitors: company.competitors,
      competitorNotes: company.competitorNotes,
      platforms: company.platforms,
      geography: company.geography,
      language: company.language,
      primaryObjective: company.primaryObjective,
      products: (company.products ?? []).filter(p => p.active).map(p => ({
        name: p.name,
        price: p.price,
        currency: p.currency,
        description: p.description,
        differentiators: p.differentiators,
        trendKeywords: p.trendKeywords,
        languages: p.languages,
      })),
      learnings: company.learnings ? {
        winningHooks: company.learnings.creative?.winningHooks,
        losingHooks: company.learnings.creative?.losingHooks,
        winningFormats: company.learnings.creative?.winningFormats,
        topAudiences: company.learnings.campaign?.audienceScores
          ? Object.entries(company.learnings.campaign.audienceScores)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([k, v]) => `${k}: ${v}`)
          : [],
      } : null,
    };
  }

  private async readSkills(skillNames: string[]): Promise<Record<string, string>> {
    const skills: Record<string, string> = {};

    let availableDirs: string[] = [];
    try {
      availableDirs = await fs.readdir(SKILLS_DIR);
    } catch {
      this.logger.warn(`Skills directory not found at ${SKILLS_DIR} — continuing without skills`);
      return skills;
    }

    const toLoad = skillNames.filter(name => availableDirs.includes(name));

    await Promise.all(
      toLoad.map(async (dir) => {
        const skillMdPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
        const readmePath = path.join(SKILLS_DIR, dir, 'README.md');
        try {
          skills[dir] = await fs.readFile(skillMdPath, 'utf-8');
        } catch {
          try {
            const content = await fs.readFile(readmePath, 'utf-8');
            if (!content.includes('Placeholder — replace')) {
              skills[dir] = content;
            }
          } catch {
            // skill dir exists but no readable file — skip silently
          }
        }
      }),
    );

    this.logger.log(`Loaded skills: ${Object.keys(skills).join(', ')}`);
    return skills;
  }

  private selectSkills(
    allSkills: Record<string, string>,
    names: string[],
  ): Record<string, string> {
    return Object.fromEntries(
      names.filter(n => allSkills[n]).map(n => [n, allSkills[n]]),
    );
  }

  /**
   * Fix literal (unescaped) newlines and carriage returns inside JSON string values.
   * The model sometimes writes multi-line prompt text directly inside JSON strings,
   * producing newlines that are valid text but invalid JSON encoding.
   */
  private fixJsonStringNewlines(jsonStr: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (escaped) {
        result += ch;
        escaped = false;
      } else if (ch === '\\' && inString) {
        result += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
        result += ch;
      } else if (inString && ch === '\n') {
        result += '\\n';
      } else if (inString && ch === '\r') {
        result += '\\r';
      } else {
        result += ch;
      }
    }
    return result;
  }

  /**
   * Last-resort per-key extraction when the full JSON is unparseable (e.g. truncated).
   * Extracts each required key individually via regex — resilient to truncation.
   */
  private extractKeysViaRegex(
    content: string,
    keys: (keyof CompanyPrompts)[],
  ): Partial<CompanyPrompts> {
    const result: Partial<CompanyPrompts> = {};
    for (const key of keys) {
      // Match "key": "value" where value may span multiple lines (unescaped newlines)
      const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)"`, 's');
      const match = content.match(pattern);
      if (match) {
        try {
          result[key] = JSON.parse(`"${match[1]}"`) as any;
        } catch {
          // Unescape manually if JSON.parse still fails on the individual value
          result[key] = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\') as any;
        }
      }
    }
    return result;
  }

  private parsePrompts(
    content: string,
    requiredKeys: (keyof CompanyPrompts)[],
    batchName: string,
  ): Partial<CompanyPrompts> {
    let parsed: Partial<CompanyPrompts> | null = null;

    // Extract raw JSON string from fence or bare object
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
    let rawJson: string;
    if (fenceMatch) {
      rawJson = fenceMatch[1].trim();
    } else {
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start === -1 || end === -1) {
        this.logger.error(`[${batchName}] No JSON object found`);
        this.logger.error(`[${batchName}] Raw response (first 500 chars): ${content.slice(0, 500)}`);
        throw new Error(`[${batchName}] returned invalid JSON: No JSON object found`);
      }
      rawJson = content.slice(start, end + 1);
    }

    // Pass 1: try direct parse
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // Pass 2: fix unescaped newlines inside string values, then retry
      try {
        parsed = JSON.parse(this.fixJsonStringNewlines(rawJson));
        this.logger.log(`[${batchName}] Parsed after newline-fix`);
      } catch {
        // Pass 3: regex per-key extraction (resilient to truncation)
        this.logger.warn(`[${batchName}] Full JSON parse failed — falling back to per-key regex extraction`);
        parsed = this.extractKeysViaRegex(content, requiredKeys);
      }
    }

    const missingKeys = requiredKeys.filter(
      key => !parsed![key] || typeof parsed![key] !== 'string' || (parsed![key] as string).trim() === '',
    );

    if (missingKeys.length > 0) {
      this.logger.error(`[${batchName}] Raw response (first 500 chars): ${content.slice(0, 500)}`);
      throw new Error(`[${batchName}] response missing keys: ${missingKeys.join(', ')}`);
    }

    requiredKeys.forEach(key => {
      this.logger.log(`[${batchName}] Prompt ready: ${key} (${(parsed![key] as string).trim().split(/\s+/).length} words)`);
    });

    return parsed!;
  }
}
