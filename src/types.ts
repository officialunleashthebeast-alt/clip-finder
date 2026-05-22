export interface RedditClip {
  title: string;
  subreddit: string;
  upvotes: number;
  thumbnail: string;
  videoUrl: string;
  dashUrl?: string;
  permalink: string;
  timestamp: number;
}

export interface TestRedditResponse {
  success: boolean;
  totalFetched: number;
  validVideos: number;
  clips: RedditClip[];
  failures?: string[];
  aiInsight?: string;
}
