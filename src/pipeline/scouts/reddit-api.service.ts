import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface RedditPostResult {
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  url: string;
  permalink: string;
  selftext: string;
  createdUtc: number;
  flair: string | null;
}

@Injectable()
export class RedditApiService {
  private readonly logger = new Logger(RedditApiService.name);
  private readonly baseUrl = 'https://www.reddit.com';
  // Reddit public JSON API requires a descriptive User-Agent to avoid rate limits
  private readonly headers = {
    'User-Agent': 'marketing-agent/1.0 (autonomous marketing intelligence)',
  };

  async searchPosts(
    query: string,
    sort: 'top' | 'hot' | 'relevance' = 'top',
    timeFilter: 'week' | 'month' | 'day' = 'week',
    limit = 15,
  ): Promise<RedditPostResult[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/search.json`, {
        params: { q: query, sort, t: timeFilter, limit, restrict_sr: false },
        headers: this.headers,
        timeout: 10000,
      });
      return this.parseListings(res.data?.data?.children ?? []);
    } catch (err: any) {
      this.logger.warn(`Reddit search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  async getSubredditTop(
    subreddit: string,
    timeFilter: 'week' | 'month' | 'day' = 'week',
    limit = 10,
  ): Promise<RedditPostResult[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/r/${subreddit}/top.json`, {
        params: { t: timeFilter, limit },
        headers: this.headers,
        timeout: 10000,
      });
      return this.parseListings(res.data?.data?.children ?? []);
    } catch (err: any) {
      this.logger.warn(`Reddit subreddit top failed for r/${subreddit}: ${err.message}`);
      return [];
    }
  }

  async fetchScoutData(
    industryQuery: string,
    geography: string,
    competitorNames: string[],
  ): Promise<{ industry: RedditPostResult[]; trending: RedditPostResult[]; competitors: RedditPostResult[] }> {
    // Pick geo-specific subreddit for trending
    const geoSubreddit = this.pickGeoSubreddit(geography);

    const [industry, trending, ...competitorResults] = await Promise.all([
      this.searchPosts(`${industryQuery}`, 'top', 'week', 15),
      this.getSubredditTop(geoSubreddit, 'week', 15),
      ...competitorNames.slice(0, 2).map(name =>
        this.searchPosts(name, 'top', 'month', 5),
      ),
    ]);

    const seen = new Set<string>();
    const competitors: RedditPostResult[] = [];
    for (const result of competitorResults) {
      for (const p of result) {
        if (!seen.has(p.permalink)) {
          seen.add(p.permalink);
          competitors.push(p);
        }
      }
    }

    return { industry, trending, competitors };
  }

  formatForPrompt(data: {
    industry: RedditPostResult[];
    trending: RedditPostResult[];
    competitors: RedditPostResult[];
  }): string {
    const fmt = (posts: RedditPostResult[]) =>
      posts.length === 0
        ? '  No results.'
        : posts
            .sort((a, b) => b.score - a.score)
            .map(
              (p, i) =>
                `  ${i + 1}. [r/${p.subreddit}] "${p.title}" | Score: ${p.score} | Comments: ${p.numComments} | ${this.baseUrl}${p.permalink}` +
                (p.selftext ? `\n     Preview: ${p.selftext.slice(0, 120).replace(/\n/g, ' ')}...` : ''),
            )
            .join('\n');

    return `
PRE-FETCHED REDDIT DATA (real API data — use these for your analysis, do NOT search Reddit again):

INDUSTRY POSTS (last 7 days, top by score):
${fmt(data.industry)}

TRENDING IN GEOGRAPHY (last 7 days):
${fmt(data.trending)}

COMPETITOR MENTIONS (last 30 days):
${fmt(data.competitors)}
    `.trim();
  }

  private parseListings(children: any[]): RedditPostResult[] {
    return children
      .map((child: any) => child.data)
      .filter((d: any) => d && !d.stickied)
      .map((d: any) => ({
        title: d.title ?? '',
        subreddit: d.subreddit ?? '',
        score: d.score ?? 0,
        numComments: d.num_comments ?? 0,
        url: d.url ?? '',
        permalink: d.permalink ?? '',
        selftext: (d.selftext ?? '').slice(0, 300),
        createdUtc: d.created_utc ?? 0,
        flair: d.link_flair_text ?? null,
      }));
  }

  private pickGeoSubreddit(geography: string): string {
    const geo = geography.toLowerCase();
    if (geo.includes('india') || geo.includes('indian')) return 'india';
    if (geo.includes('us') || geo.includes('united states') || geo.includes('america')) return 'unitedstates';
    if (geo.includes('uk') || geo.includes('britain')) return 'unitedkingdom';
    if (geo.includes('australia')) return 'australia';
    if (geo.includes('canada')) return 'canada';
    // Default fallback
    return 'worldnews';
  }
}
