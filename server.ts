import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Readable } from "stream";
import { finished } from "stream/promises";
import { promises as fs, createReadStream, createWriteStream } from "fs";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const REDDIT_NAME = process.env.REDDIT_APP_NAME || "MyRedditVidsScraper";
const POSTS_PER_SUBREDDIT = 10;
const SCRAPE_TIMEOUT_MS = 3500;
const HOT_BATCH_SIZE = 25;
const MAX_HOT_SCAN_POSTS = 100;
const SOURCE_BLEND = [
  { sort: "hot", limit: HOT_BATCH_SIZE, time: "" }
] as const;
const TARGET_SUBREDDITS = [
  "CrazyFuckingVideos",
  "PublicFreakout",
  "AbruptChaos",
  "Unexpected",
  "IdiotsInCars",
  "Whatcouldgowrong",
  "WinStupidPrizes",
  "therewasanattempt",
  "nonononoyes",
  "yesyesyesyesno",
  "nextfuckinglevel",
  "SweatyPalms",
  "WhyWereTheyFilming",
  "Holdmybeer",
  "WatchPeopleDieInside",
  "HumansBeingBros",
  "BetterEveryLoop",
  "perfectlycutscreams",
  "maybemaybemaybe",
  "interestingasfuck"
];

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Use JSON middleware
  app.use(express.json());

  // 1. Core Scrape API
  app.get("/api/scrape", async (req, res) => {
    console.log("[BACKEND] GET /api/scrape endpoint triggered.");
    const results = await Promise.all(
      TARGET_SUBREDDITS.map(async (subreddit) => fetchSubredditResult(subreddit))
    );

    const allClips = results.flatMap((result) => result.clips);
    const totalFetched = results.reduce((sum, result) => sum + result.totalFetched, 0);

    const dedupedClips = dedupeClips(allClips)
      .sort((a, b) => b.timestamp - a.timestamp);

    console.log(
      `[BACKEND SCRAPER RESPONSE] Finished processing. Total raw posts: ${totalFetched}. Valid clips: ${dedupedClips.length}.`
    );

    res.json({
      success: true,
      totalFetched,
      validVideos: dedupedClips.length,
      clips: dedupedClips,
      failures: []
    });
  });

  // 2. Video Streaming Proxy supporting headers and range requests
  app.get("/api/proxy-video", async (req, res) => {
    const videoUrl = req.query.url as string;
    if (!videoUrl) {
      return res.status(400).send("Parameter 'url' is required.");
    }

    const rangeHeader = req.headers.range;
    const requestHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://www.reddit.com/",
      "Accept-Language": "en-US,en;q=0.9"
    };

    if (rangeHeader) {
      requestHeaders["Range"] = rangeHeader;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s connection trigger limit

    try {
      const response = await fetch(videoUrl, {
        headers: requestHeaders,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok && response.status !== 206) {
        console.warn(`[BACKEND VIDEO PROXY] Reddit asset endpoint failed: ${response.status}`);
        return res.status(response.status).send(`Upstream err: ${response.status}`);
      }

      // Propagate original response code
      res.status(response.status);

      // Copy headers from response to keep browser player happy
      const contentType = response.headers.get("content-type");
      const contentRange = response.headers.get("content-range");
      const acceptRanges = response.headers.get("accept-ranges");
      const contentLength = response.headers.get("content-length");

      res.setHeader("Content-Type", contentType || "video/mp4");
      if (contentRange) res.setHeader("Content-Range", contentRange);
      if (acceptRanges) {
        res.setHeader("Accept-Ranges", acceptRanges);
      } else if (response.status === 206) {
        res.setHeader("Accept-Ranges", "bytes");
      }
      if (contentLength) res.setHeader("Content-Length", contentLength);

      res.setHeader("Cache-Control", "public, max-age=86400");

      if (response.body) {
        const stream = Readable.fromWeb(response.body as any);
        
        req.on("close", () => {
          controller.abort();
          stream.destroy();
        });

        stream.pipe(res);
        console.log(`[BACKEND VIDEO PROXY] preview proxy success: forwarding portion range for: ${videoUrl.substring(0, 60)}...`);
      } else {
        res.end();
      }
    } catch (err: any) {
      console.warn(`[BACKEND VIDEO PROXY FAILURE] suffers exception: ${err?.message || String(err)}`);
      if (!res.headersSent) {
        res.status(500).send("Preview unavailable");
      }
    }
  });

  // 3. Download Proxy Route
  app.get("/api/download", async (req, res) => {
    const videoUrl = req.query.url as string;
    const requestedTitle = typeof req.query.title === "string" ? req.query.title : "";
    const requestedDashUrl = typeof req.query.dashUrl === "string" ? req.query.dashUrl : "";
    if (!videoUrl) {
      return res.status(400).send("Parameter 'url' is required.");
    }

    console.log(`[BACKEND DOWNLOAD] Processing stream pipe target: ${videoUrl}`);
    const title = sanitizeMetadataValue(requestedTitle) || "Untitled Viral Moment";
    const tempDir = path.join(os.tmpdir(), `reddit-scraper-${crypto.randomUUID()}`);

    try {
      await fs.mkdir(tempDir, { recursive: true });

      const videoInputPath = path.join(tempDir, "video.mp4");
      const audioInputPath = path.join(tempDir, "audio.mp4");
      const outputPath = path.join(tempDir, "output.mp4");

      let muxedWithDashManifest = false;
      if (requestedDashUrl) {
        try {
          await muxVideoFromDashManifest({
            dashUrl: requestedDashUrl,
            outputPath,
            title
          });
          muxedWithDashManifest = true;
        } catch (err: any) {
          console.warn(`[BACKEND DOWNLOAD] Dash manifest mux failed, falling back to direct media download: ${err?.message || String(err)}`);
        }
      }

      if (!muxedWithDashManifest) {
        await downloadRemoteFile(videoUrl, videoInputPath);

        const audioUrl = await findMatchingAudioUrl(videoUrl);
        const hasSeparateAudio = Boolean(audioUrl);
        if (audioUrl) {
          await downloadRemoteFile(audioUrl, audioInputPath);
        }

        await muxVideoForDownload({
          videoInputPath,
          audioInputPath: hasSeparateAudio ? audioInputPath : null,
          outputPath,
          title
        });
      }

      const filename = buildDownloadFilename(title);
      const outputStats = await fs.stat(outputPath);

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", String(outputStats.size));

      const stream = createReadStream(outputPath);

      req.on("close", () => {
        stream.destroy();
      });

      res.on("finish", async () => {
        await cleanupDirectory(tempDir);
      });

      res.on("close", async () => {
        await cleanupDirectory(tempDir);
      });

      stream.pipe(res);
      console.log(`[BACKEND DOWNLOAD] download success: successfully downloaded and streamed video: ${filename}`);
    } catch (err: any) {
      console.error(`[BACKEND DOWNLOAD FAILURE] suffers exception: ${err?.message || String(err)}`);
      await cleanupDirectory(tempDir);
      if (!res.headersSent) {
        res.status(500).send("Download failed");
      }
    }
  });

  // 4. Vite / SPA Static routing
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    console.log("[BACKEND] Vite dev middleware loaded.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("[BACKEND] Production static routes loaded.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[BACKEND SUCCESS] Dev/Prod Server active on host 0.0.0.0, port ${PORT}`);
  });
}

/**
 * Extraction utility with strict Reddit fallback filters & matching
 */
function extractRedditClip(post: any) {
  const data = post?.data;
  if (!data) return null;

  // Exact fallback check specified by user: ONLY fallback MP4 URLs. No manifests, no adaptive HLS.
  let videoUrl = "";

  if (data.secure_media?.reddit_video?.fallback_url) {
    videoUrl = data.secure_media.reddit_video.fallback_url;
  } else if (data.media?.reddit_video?.fallback_url) {
    videoUrl = data.media.reddit_video.fallback_url;
  } else if (data.preview?.reddit_video_preview?.fallback_url) {
    videoUrl = data.preview.reddit_video_preview.fallback_url;
  }

  // Fallback to absolute url if labeled video but direct media structures missed
  if (!videoUrl && data.is_video && data.url) {
    const isUrlMp4 = data.url.toLowerCase().includes(".mp4");
    if (isUrlMp4) {
      videoUrl = data.url;
    }
  }

  if (!videoUrl) return null;

  // Clean raw character bindings
  videoUrl = videoUrl.replace(/&amp;/g, "&");

  // Keep only clips that have actual video formats (skip playlists like m3u8 or mpd manifests if any slip past)
  if (videoUrl.includes(".m3u8") || videoUrl.includes(".mpd")) {
    return null;
  }

  if (!isLikelyPlayableVideoUrl(videoUrl)) {
    return null;
  }

  // Thumbnail checking
  let thumbnail = "";
  if (data.thumbnail && typeof data.thumbnail === "string" && data.thumbnail.startsWith("http")) {
    thumbnail = data.thumbnail;
  } else if (data.preview?.images?.[0]?.source?.url) {
    thumbnail = data.preview.images[0].source.url;
  }

  if (thumbnail) {
    thumbnail = thumbnail.replace(/&amp;/g, "&");
  } else {
    thumbnail = "https://images.unsplash.com/photo-1540747737956-3787293a9fc1?auto=format&fit=crop&q=80&w=400";
  }

  // Canonical comments links URL
  const permalink = data.permalink 
    ? (data.permalink.startsWith("http") ? data.permalink : `https://www.reddit.com${data.permalink}`)
    : `https://www.reddit.com/r/${data.subreddit || "all"}`;

  return {
    title: data.title || "Untitled Viral Moment",
    subreddit: data.subreddit || "reddit",
    upvotes: data.ups !== undefined ? data.ups : (data.score || 0),
    thumbnail,
    videoUrl,
    dashUrl: getDashUrl(data),
    permalink,
    timestamp: data.created_utc || Math.floor(Date.now() / 1000)
  };
}

async function fetchSubredditResult(subreddit: string) {
  const liveResult = await fetchLiveSubredditClips(subreddit);
  return liveResult;
}

async function fetchLiveSubredditClips(subreddit: string) {
  const settledListings = await Promise.all(
    SOURCE_BLEND.map(async (source) => {
      try {
        return await fetchListingForSource(subreddit, source.sort, source.limit, source.time);
      } catch (err: any) {
        console.warn(
          `[BACKEND SCRAPER TRY FAILURE] r/${subreddit} source [${source.sort}] failed: ${err?.message || String(err)}`
        );
        return {
          source: source.sort,
          totalFetched: 0,
          clips: []
        };
      }
    })
  );

  const totalFetched = settledListings.reduce((sum, listing) => sum + listing.totalFetched, 0);
  const clips = dedupeClips(
    settledListings.flatMap((listing) => listing.clips)
  ).slice(0, POSTS_PER_SUBREDDIT);

  if (clips.length > 0) {
    console.log(
      `[BACKEND SCRAPER RESPONSE SUCCESS] r/${subreddit} retrieved successfully via blended sources. Matches: ${clips.length}`
    );
    return {
      totalFetched,
      clips,
      failure: null
    };
  }

  return {
    totalFetched,
    clips: [],
    failure: null
  };
}

async function fetchListingForSource(
  subreddit: string,
  sort: "new" | "hot" | "rising" | "top",
  limit: number,
  time: string
) {
  let after = "";
  let totalFetched = 0;
  let clips: any[] = [];

  while (totalFetched < MAX_HOT_SCAN_POSTS && clips.length < POSTS_PER_SUBREDDIT) {
    const directUrl = buildListingUrl(subreddit, sort, limit, time, after);
    const strategies = [
      {
        name: "Direct Reddit",
        url: directUrl,
        unpackWrappedJson: false
      },
      {
        name: "AllOrigins",
        url: `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`,
        unpackWrappedJson: true
      },
      {
        name: "Redlib",
        url: buildRedlibListingUrl(subreddit, sort, limit, time, after),
        unpackWrappedJson: false
      }
    ];

    let pageChildren: any[] = [];
    let nextAfter = "";

    for (const strategy of strategies) {
      try {
        const payload = await fetchJsonPayload(strategy.url, strategy.unpackWrappedJson);
        pageChildren = Array.isArray(payload?.data?.children) ? payload.data.children : [];
        nextAfter = typeof payload?.data?.after === "string" ? payload.data.after : "";
        if (pageChildren.length > 0) {
          break;
        }
      } catch (err: any) {
        console.warn(
          `[BACKEND SCRAPER TRY FAILURE] Strat [${strategy.name}] failed for r/${subreddit}/${sort}: ${err?.message || String(err)}`
        );
      }
    }

    if (pageChildren.length === 0) {
      break;
    }

    totalFetched += pageChildren.length;
    clips = dedupeClips([
      ...clips,
      ...pageChildren.map((child: any) => extractRedditClip(child)).filter(Boolean)
    ]);

    if (!nextAfter || nextAfter === after) {
      break;
    }

    after = nextAfter;
  }

  return {
    source: sort,
    totalFetched,
    clips: clips.slice(0, POSTS_PER_SUBREDDIT)
  };
}

function buildListingUrl(subreddit: string, sort: string, limit: number, time: string, after = "") {
  const params = new URLSearchParams({
    raw_json: "1",
    limit: String(limit)
  });

  if (time) {
    params.set("t", time);
  }

  if (after) {
    params.set("after", after);
  }

  return `https://www.reddit.com/r/${subreddit}/${sort}.json?${params.toString()}`;
}

function buildRedlibListingUrl(subreddit: string, sort: string, limit: number, time: string, after = "") {
  const params = new URLSearchParams({
    limit: String(limit)
  });

  if (time) {
    params.set("t", time);
  }

  if (after) {
    params.set("after", after);
  }

  return `https://redlib.catsarch.com/r/${subreddit}/${sort}.json?${params.toString()}`;
}

async function fetchJsonPayload(url: string, unpackWrappedJson: boolean) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        ...getStandardFetchHeaders(),
        "User-Agent": `${REDDIT_NAME}/1.0`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Endpoint returned HTTP ${response.status}`);
    }

    let text = await response.text();

    if (unpackWrappedJson) {
      const wrapped = JSON.parse(text);
      text = typeof wrapped?.contents === "string" ? wrapped.contents : "";
    }

    if (!text || !text.trim().startsWith("{")) {
      throw new Error("Payload did not yield clean JSON layout structure.");
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

function dedupeClips(clips: any[]) {
  const seen = new Set<string>();
  return clips.filter((clip) => {
    const key = `${clip.permalink}|${clip.videoUrl}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isLikelyPlayableVideoUrl(videoUrl: string) {
  if (!videoUrl) return false;

  try {
    const parsed = new URL(videoUrl);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "v.redd.it" ||
      hostname.endsWith(".redd.it") ||
      videoUrl.toLowerCase().includes(".mp4")
    );
  } catch {
    return false;
  }
}

function getDashUrl(data: any) {
  const dashUrl =
    data.secure_media?.reddit_video?.dash_url ||
    data.media?.reddit_video?.dash_url ||
    "";

  if (typeof dashUrl !== "string") {
    return undefined;
  }

  return dashUrl.replace(/&amp;/g, "&");
}

function sanitizeMetadataValue(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function sanitizeFilenamePart(value: string) {
  return sanitizeMetadataValue(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDownloadFilename(title: string) {
  return "raw-video.mp4";
}

async function cleanupDirectory(targetDir: string) {
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
  } catch {}
}

function getStandardFetchHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.reddit.com/",
    "Accept-Language": "en-US,en;q=0.9"
  };
}

async function downloadRemoteFile(sourceUrl: string, outputPath: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000);

  try {
    const response = await fetch(sourceUrl, {
      headers: getStandardFetchHeaders(),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Upstream download source failed: ${response.status}`);
    }

    const outputStream = createWriteStream(outputPath);
    const inputStream = Readable.fromWeb(response.body as any);
    inputStream.pipe(outputStream);
    await finished(outputStream);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeRemoteFile(sourceUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        ...getStandardFetchHeaders(),
        "Range": "bytes=0-1"
      },
      signal: controller.signal
    });

    return response.ok || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findMatchingAudioUrl(videoUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(videoUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== "v.redd.it") {
    return null;
  }

  const pathParts = parsed.pathname.split("/");
  const filename = pathParts[pathParts.length - 1] || "";
  const basePath = parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1);

  if (!/^DASH_/i.test(filename)) {
    return null;
  }

  const candidates = [
    "DASH_AUDIO_128.mp4",
    "DASH_AUDIO_64.mp4",
    "DASH_AUDIO_96.mp4",
    "DASH_audio.mp4",
    "audio",
    "audio.mp4"
  ].map((candidateName) => {
    const candidate = new URL(parsed.toString());
    candidate.pathname = `${basePath}${candidateName}`;
    candidate.search = "";
    return candidate.toString();
  });

  for (const candidate of candidates) {
    if (await probeRemoteFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function muxVideoForDownload({
  videoInputPath,
  audioInputPath,
  outputPath,
  title
}: {
  videoInputPath: string;
  audioInputPath: string | null;
  outputPath: string;
  title: string;
}) {
  const args = [
    "-y",
    "-i",
    videoInputPath
  ];

  if (audioInputPath) {
    args.push("-i", audioInputPath);
  }

  args.push(
    "-map", "0:v:0"
  );

  if (audioInputPath) {
    args.push("-map", "1:a:0");
  } else {
    args.push("-map", "0:a?");
  }

  args.push(
    "-c", "copy",
    "-movflags", "+faststart",
    "-metadata", `title=${title}`,
    outputPath
  );

  await execFileAsync("ffmpeg", args, { windowsHide: true });
}

async function muxVideoFromDashManifest({
  dashUrl,
  outputPath,
  title
}: {
  dashUrl: string;
  outputPath: string;
  title: string;
}) {
  const args = [
    "-y",
    "-user_agent",
    `${REDDIT_NAME}/1.0`,
    "-headers",
    "Referer: https://www.reddit.com/\r\nAccept-Language: en-US,en;q=0.9\r\n",
    "-i",
    dashUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-metadata",
    `title=${title}`,
    outputPath
  ];

  await execFileAsync("ffmpeg", args, { windowsHide: true });
}

startServer();
