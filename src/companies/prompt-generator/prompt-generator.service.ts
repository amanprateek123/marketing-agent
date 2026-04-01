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
6. Each prompt should be 400-700 words — detailed enough to be useful, concise enough to fit in context.

───────────────────────────────────────────
SCOUT PROMPT REQUIREMENTS (instagramScout, redditScout, twitterScout, youtubeScout)
───────────────────────────────────────────
All 4 scout prompts MUST include these 3 sections in addition to brand-specific focus areas:

SECTION A — LIVE DATA TOOLS:
Instruct the scout to use real tools to fetch live data — never rely on memory or training data.
- instagramScout + twitterScout + redditScout: use web_search tool with specific search queries.
  For redditScout use search queries like: "site:reddit.com/r/astrology [topic]", "site:reddit.com [topic] upvotes"
  to find real Reddit threads. Extract post URLs, visible upvote counts, and post dates from results.
- youtubeScout: use bash tool to call YouTube Data API with this exact key ${youtubeApiKey}:
  curl "https://www.googleapis.com/youtube/v3/search?part=snippet&q={query}&type=video&order=viewCount&publishedAfter={7_days_ago}&maxResults=20&key=${youtubeApiKey}"
  Extract real view counts and publish dates from the response.

SECTION B — SOURCE ATTRIBUTION RULE:
Every signal the scout reports MUST include:
- A real URL where the signal was found
- A real engagement number (upvotes, views, likes, shares) with the source of that number
- The recency of the signal (post/publish date)
- If a URL or engagement number cannot be found — DO NOT include that signal. No invented data.

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
Focus on: synthesis logic, scoring frameworks, output structure, brand voice, decision criteria.

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
  "ideaPool": "...",
  "digestWriter": "..."
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
  'ideaPool',
  'digestWriter',
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

    const result = await this.claudeService.runAgent({
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
      maxTurns: 10,
    });

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
    };
  }

  private async readAllSkills(): Promise<Record<string, string>> {
    const skills: Record<string, string> = {};

    let skillDirs: string[] = [];
    try {
      skillDirs = await fs.readdir(SKILLS_DIR);
    } catch {
      this.logger.warn(`Skills directory not found at ${SKILLS_DIR} — continuing without skills`);
      return skills;
    }

    await Promise.all(
      skillDirs.map(async (dir) => {
        // Try SKILL.md first (coreyhaines31/marketingskills format), fallback to README.md
        const skillMdPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
        const readmePath = path.join(SKILLS_DIR, dir, 'README.md');
        try {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          skills[dir] = content;
        } catch {
          try {
            const content = await fs.readFile(readmePath, 'utf-8');
            // Skip placeholder files
            if (!content.includes('Placeholder — replace')) {
              skills[dir] = content;
            }
          } catch {
            // Skill dir exists but no readable file — skip silently
          }
        }
      }),
    );

    this.logger.log(`Loaded ${Object.keys(skills).length} skills`);
    return skills;
  }

  private parsePrompts(content: string): CompanyPrompts {
    let parsed: Partial<CompanyPrompts>;

    try {
      // Strip possible markdown code fences if Claude wraps the JSON
      const cleaned = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Prompt Generator returned invalid JSON.\n\nRaw response:\n${content}`);
    }

    // Validate all 9 keys are present and non-empty
    const missingKeys = REQUIRED_PROMPT_KEYS.filter(
      (key) => !parsed[key] || typeof parsed[key] !== 'string' || parsed[key]!.trim() === '',
    );

    if (missingKeys.length > 0) {
      throw new Error(`Prompt Generator response missing keys: ${missingKeys.join(', ')}`);
    }

    return parsed as CompanyPrompts;
  }
}
