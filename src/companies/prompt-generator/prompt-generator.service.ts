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

const buildPromptGeneratorSystemPrompt = (youtubeApiKey: string) => `
You are a prompt engineering expert specializing in marketing AI agents.

CRITICAL RULES:
1. NEVER hardcode any product names, prices, offers, or calendar dates into the system prompts.
   These will be injected at runtime as live operational data.
2. Reference products/prices as "the company's current product catalog" or "active offerings".
3. Reference calendar events as "upcoming calendar events" or "current seasonal context".
4. Focus ONLY on: brand voice, audience psychology, frameworks, competitor positioning,
   strategic patterns, and proven methodologies from the skills provided.
5. Each prompt must be deeply specific to THIS company's industry, tone, and audience —
   but generic enough that price/product changes don't require regeneration.
6. Scout prompts (instagramScout, redditScout, twitterScout, youtubeScout): 600-900 words —
   they must include all 3 required sections plus brand-specific focus areas.
   metaAdsLibrary prompt: 400-600 words — include brand-specific focus on which competitor ads to watch for,
   what messaging angles to flag as threats, and what gaps would be most valuable for this brand to own.
   Non-scout prompts (coordinator, competitorResearch, marketResearch, ideaPool, digestWriter, campaignCreator): 300-500 words —
   focus on synthesis logic, scoring criteria, and brand voice.

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
NON-SCOUT PROMPTS (coordinator, competitorResearch, marketResearch, ideaPool, digestWriter)
───────────────────────────────────────────
These agents receive already-collected data. They do NOT need tool usage instructions.
Focus on: synthesis logic, scoring frameworks, brand voice, decision criteria.

Specific guidance per agent:
- coordinator: How to weigh signals across platforms, what makes a signal worth escalating,
  how to identify cross-platform consensus vs platform-specific noise.
- competitorResearch: What competitor weaknesses and content gaps are most exploitable for THIS brand,
  how to frame gaps as opportunities.
- marketResearch: What market signals matter most for THIS company's category and audience.
- ideaPool: Brand voice guidelines for idea generation, what makes an idea on-brand vs off-brand,
  how to bridge content ideas to this company's conversion goals.
- digestWriter: Tone and format for the weekly intelligence digest, what executives/founders of
  THIS type of company want to see first, how to prioritize findings.

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
  "instagramScout": "...",
  "redditScout": "...",
  "twitterScout": "...",
  "youtubeScout": "...",
  "coordinator": "...",
  "competitorResearch": "...",
  "marketResearch": "...",
  "metaAdsLibrary": "...",
  "ideaPool": "...",
  "digestWriter": "...",
  "campaignCreator": "..."
}

No markdown, no explanation, no code blocks — just the raw JSON object.
`.trim();

const REQUIRED_PROMPT_KEYS: (keyof CompanyPrompts)[] = [
  'instagramScout',
  'redditScout',
  'twitterScout',
  'youtubeScout',
  'coordinator',
  'competitorResearch',
  'marketResearch',
  'metaAdsLibrary',
  'ideaPool',
  'digestWriter',
  'campaignCreator',
];

@Injectable()
export class PromptGeneratorService {
  private readonly logger = new Logger(PromptGeneratorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly configService: ConfigService,
  ) {}

  async generate(tenantId: string): Promise<CompanyPrompts> {
    this.logger.log(`Generating prompts for: ${tenantId}`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const skillContents = await this.readAllSkills();

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.PROMPT_GENERATOR,
        systemPrompt: buildPromptGeneratorSystemPrompt(
          this.configService.get<string>('youtube.apiKey') ?? '',
        ),
        liveContext: '',
        userMessage: JSON.stringify({
          companyProfile: this.buildCompanyProfile(company),
          skills: skillContents,
        }),
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
      });
    } catch (err: any) {
      this.logger.error(`Claude agent failed for ${tenantId}: ${err.message}`);
      throw err;
    }

    if (!result.content || result.content.trim() === '') {
      this.logger.error(`Prompt generator returned empty content for ${tenantId}`);
      throw new Error('Prompt generator returned empty content');
    }

    this.logger.log(`Raw response received: ${result.content.length} chars | tokens in:${result.inputTokens} out:${result.outputTokens} cost:$${result.costUSD.toFixed(4)}`);

    const prompts = this.parsePrompts(result.content);
    await this.companiesService.updatePrompts(tenantId, prompts);

    this.logger.log(`Prompts generated and saved for: ${tenantId}`);
    return prompts;
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
      // Product catalog — so prompts understand what the company sells
      products: (company.products ?? []).filter(p => p.active).map(p => ({
        name: p.name,
        price: p.price,
        currency: p.currency,
        description: p.description,
        differentiators: p.differentiators,
        trendKeywords: p.trendKeywords,
        languages: p.languages,
      })),
      // Past learnings — so prompts incorporate what worked before
      learnings: company.learnings ? {
        winningHooks: company.learnings.creative?.winningHooks,
        losingHooks: company.learnings.creative?.losingHooks,
        winningFormats: company.learnings.creative?.winningFormats,
        topAudiences: company.learnings.campaign?.audienceScores
          ? Object.entries(company.learnings.campaign.audienceScores)
              .sort(([,a],[,b]) => b - a)
              .slice(0, 5)
              .map(([k,v]) => `${k}: ${v}`)
          : [],
      } : null,
    };
  }

  // Only marketing skills are useful for prompt generation.
  // Technical/execution skills (autonomous-loops, continuous-learning-v2, etc.)
  // are implemented in TypeScript code — not needed in agent prompts.
  private readonly MARKETING_SKILLS = [
    'ad-creative',
    'paid-ads',
    'copywriting',
    'marketing-psychology',
    'social-content',
    'customer-research',
    'competitor-alternatives',
    'market-research',
    'product-marketing-context',
  ];

  private async readAllSkills(): Promise<Record<string, string>> {
    const skills: Record<string, string> = {};

    let skillDirs: string[] = [];
    try {
      skillDirs = await fs.readdir(SKILLS_DIR);
    } catch {
      this.logger.warn(`Skills directory not found at ${SKILLS_DIR} — continuing without skills`);
      return skills;
    }

    // Only load marketing skills — skip technical/execution skills
    const relevantDirs = skillDirs.filter((dir) => this.MARKETING_SKILLS.includes(dir));

    await Promise.all(
      relevantDirs.map(async (dir) => {
        const skillMdPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
        const readmePath = path.join(SKILLS_DIR, dir, 'README.md');
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          skills[dir] = content;
        } catch {
          try {
            const content = await fs.readFile(readmePath, 'utf-8');
            if (!content.includes('Placeholder — replace')) {
              skills[dir] = content;
            }
          } catch {
            // Skill dir exists but no readable file — skip silently
          }
        }
      }),
    );

    this.logger.log(`Loaded ${Object.keys(skills).length} marketing skills`);
    return skills;
  }

  private parsePrompts(content: string): CompanyPrompts {
    let parsed: Partial<CompanyPrompts>;

    try {
      // Try to extract a ```json block first (Claude often adds explanation before it)
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        parsed = JSON.parse(fenceMatch[1].trim());
      } else {
        // Fallback: find the outermost { ... } in the response
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start === -1 || end === -1) {
          throw new Error('No JSON object found in response');
        }
        parsed = JSON.parse(content.slice(start, end + 1));
      }
    } catch (err: any) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      this.logger.error(`Raw response (first 500 chars): ${content.slice(0, 500)}`);
      throw new Error(`Prompt Generator returned invalid JSON: ${err.message}`);
    }

    // Validate all 9 keys are present and non-empty
    const missingKeys = REQUIRED_PROMPT_KEYS.filter(
      (key) => !parsed[key] || typeof parsed[key] !== 'string' || parsed[key]!.trim() === '',
    );

    if (missingKeys.length > 0) {
      throw new Error(`Prompt Generator response missing keys: ${missingKeys.join(', ')}`);
    }

    REQUIRED_PROMPT_KEYS.forEach((key) => {
      this.logger.log(`Prompt ready: ${key} (${parsed[key]!.trim().split(/\s+/).length} words)`);
    });

    return parsed as CompanyPrompts;
  }
}
