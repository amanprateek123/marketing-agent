import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface YoutubeVideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  url: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

@Injectable()
export class YoutubeApiService {
  private readonly logger = new Logger(YoutubeApiService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('youtube.apiKey') ?? '';
  }

  async searchVideos(
    query: string,
    publishedAfterDays = 7,
    maxResults = 10,
  ): Promise<YoutubeVideoResult[]> {
    if (!this.apiKey) {
      this.logger.warn('YOUTUBE_API_KEY not set — skipping YouTube API fetch');
      return [];
    }

    const publishedAfter = new Date(Date.now() - publishedAfterDays * 24 * 60 * 60 * 1000)
      .toISOString();

    try {
      // Step 1: Search for video IDs
      const searchRes = await axios.get(`${this.baseUrl}/search`, {
        params: {
          part: 'snippet',
          q: query,
          type: 'video',
          publishedAfter,
          order: 'viewCount',
          maxResults,
          key: this.apiKey,
        },
        timeout: 10000,
      });

      const items = searchRes.data?.items ?? [];
      if (items.length === 0) return [];

      const videoIds = items.map((i: any) => i.id?.videoId).filter(Boolean).join(',');

      // Step 2: Fetch real statistics for those videos
      const statsRes = await axios.get(`${this.baseUrl}/videos`, {
        params: {
          part: 'statistics,snippet',
          id: videoIds,
          key: this.apiKey,
        },
        timeout: 10000,
      });

      return (statsRes.data?.items ?? []).map((v: any) => ({
        videoId: v.id,
        title: v.snippet?.title ?? '',
        channelTitle: v.snippet?.channelTitle ?? '',
        publishedAt: v.snippet?.publishedAt ?? '',
        url: `https://www.youtube.com/watch?v=${v.id}`,
        viewCount: parseInt(v.statistics?.viewCount ?? '0', 10),
        likeCount: parseInt(v.statistics?.likeCount ?? '0', 10),
        commentCount: parseInt(v.statistics?.commentCount ?? '0', 10),
      }));
    } catch (err: any) {
      this.logger.warn(`YouTube API search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  // Run multiple queries and return combined deduplicated results
  async fetchScoutData(
    industryQuery: string,
    viralQuery: string,
    competitorQueries: string[],
  ): Promise<{ industry: YoutubeVideoResult[]; viral: YoutubeVideoResult[]; competitors: YoutubeVideoResult[] }> {
    const [industry, viral, ...competitorResults] = await Promise.all([
      this.searchVideos(industryQuery, 7, 10),
      this.searchVideos(viralQuery, 7, 10),
      ...competitorQueries.slice(0, 2).map(q => this.searchVideos(q, 14, 5)),
    ]);

    // Flatten competitor results and deduplicate by videoId
    const seen = new Set<string>();
    const competitors: YoutubeVideoResult[] = [];
    for (const result of competitorResults) {
      for (const v of result) {
        if (!seen.has(v.videoId)) {
          seen.add(v.videoId);
          competitors.push(v);
        }
      }
    }

    return { industry, viral, competitors };
  }

  formatForPrompt(data: {
    industry: YoutubeVideoResult[];
    viral: YoutubeVideoResult[];
    competitors: YoutubeVideoResult[];
  }): string {
    const fmt = (videos: YoutubeVideoResult[]) =>
      videos.length === 0
        ? '  No results.'
        : videos
            .sort((a, b) => b.viewCount - a.viewCount)
            .map(
              (v, i) =>
                `  ${i + 1}. "${v.title}" by ${v.channelTitle} | Views: ${v.viewCount.toLocaleString()} | Likes: ${v.likeCount.toLocaleString()} | Published: ${v.publishedAt.slice(0, 10)} | ${v.url}`,
            )
            .join('\n');

    return `
PRE-FETCHED YOUTUBE DATA (real API data — use these for your analysis, do NOT search YouTube again):

INDUSTRY VIDEOS (last 7 days, ranked by views):
${fmt(data.industry)}

VIRAL / TRENDING VIDEOS (last 7 days):
${fmt(data.viral)}

COMPETITOR VIDEOS (last 14 days):
${fmt(data.competitors)}
    `.trim();
  }
}
