import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Readable } from "stream";
import { finished } from "stream/promises";
import { promises as fs, createReadStream, createWriteStream } from "fs";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { muxVideoForDownload, spawnMuxToStream, spawnMuxToStreamFromUrls, QUALITY_PRESETS } from "./src/ffmpeg.ts";
const REDDIT_NAME = process.env.REDDIT_APP_NAME || "MyRedditVidsScraper";
const POSTS_PER_SUBREDDIT = 10;
// Per-strategy timeouts. Direct Reddit is fast; the public proxies need more headroom.
const TIMEOUT_DIRECT_MS = 5000;
const TIMEOUT_ALLORIGINS_MS = 9000;
const TIMEOUT_REDLIB_MS = 7000;
// Cap parallel subreddit fetches so Reddit doesn't 429 the whole burst.
const MAX_PARALLEL_SUBREDDITS = 4;
// Small jitter (ms) before each subreddit kicks off, to de-sync the herd.
const SUBREDDIT_STAGGER_MAX_MS = 350;
const HOT_BATCH_SIZE = 25;
const MAX_HOT_SCAN_POSTS = 100;
const SOURCE_BLEND = [
  { sort: "hot", limit: HOT_BATCH_SIZE, time: "" }
] as const;
// Multiple Redlib mirrors — pick one at random per request so a single rate-limited
// host doesn't kill every fallback.
const REDLIB_MIRRORS = [
  "https://redlib.catsarch.com",
  "https://redlib.kittenswithcrowns.xyz",
  "https://safereddit.com",
  "https://redlib.privacydev.net"
];
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
    const results = await runWithConcurrency(
      TARGET_SUBREDDITS,
      MAX_PARALLEL_SUBREDDITS,
      async (subreddit) => fetchSubredditResult(subreddit)
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
  // Strategy (best quality + fastest path):
  //   1. Resolve a DASH manifest URL (use provided dashUrl, else derive from v.redd.it videoUrl).
  //   2. Parse the manifest, pick the highest-resolution video Representation + highest-bitrate audio.
  //   3. Hand those URLs DIRECTLY to FFmpeg (no disk staging) and stream-copy to the response.
  //      → No re-encode (instant) + no quality loss (lossless mux) + parallel HTTP fetch in FFmpeg.
  //   4. Fall back to fallback_url + probed audio only if every DASH attempt fails.
  app.get("/api/download", async (req, res) => {
    const videoUrl = req.query.url as string;
    const requestedTitle = typeof req.query.title === "string" ? req.query.title : "";
    const requestedDashUrl = typeof req.query.dashUrl === "string" ? req.query.dashUrl : "";
    if (!videoUrl) {
      return res.status(400).send("Parameter 'url' is required.");
    }

    console.log(`[BACKEND DOWNLOAD] Processing stream pipe target: ${videoUrl}`);
    const title = sanitizeMetadataValue(requestedTitle) || "Untitled Viral Moment";
    const filename = buildDownloadFilename(title);

    let ffmpegProc: import("child_process").ChildProcess | null = null;
    let tempDir: string | null = null;

    try {
      // ---------- FAST PATH: DASH-direct, highest quality ----------
      // If frontend didn't pass dashUrl, derive it for v.redd.it videos.
      const dashUrlCandidate = requestedDashUrl || deriveDashUrlFromVideoUrl(videoUrl);

      if (dashUrlCandidate) {
        try {
          const dashStreams = await resolveHighestQualityDashStreams(dashUrlCandidate);
          if (dashStreams.videoUrl) {
            console.log(
              `[BACKEND DOWNLOAD] DASH best-quality picked: video=${shortUrl(dashStreams.videoUrl)} audio=${dashStreams.audioUrl ? shortUrl(dashStreams.audioUrl) : "none"}`
            );
            ffmpegProc = spawnMuxToStreamFromUrls(
              dashStreams.videoUrl,
              dashStreams.audioUrl || null,
              title
            );
          } else {
            console.warn(
              `[BACKEND DOWNLOAD] DASH manifest had no video representations, falling back to fallback_url.`
            );
          }
        } catch (err: any) {
          console.warn(
            `[BACKEND DOWNLOAD] DASH path failed (${err?.message || String(err)}), falling back to fallback_url.`
          );
        }
      }

      // ---------- SLOW PATH: fallback_url + probed audio ----------
      // Only runs when DASH resolution failed entirely. We still pipe URLs directly
      // to FFmpeg here too — no disk staging — to keep things fast.
      if (!ffmpegProc) {
        const audioUrl = await findMatchingAudioUrl(videoUrl);
        if (audioUrl) {
          console.log(`[BACKEND DOWNLOAD] Fallback path with separate audio: ${shortUrl(audioUrl)}`);
        }
        ffmpegProc = spawnMuxToStreamFromUrls(videoUrl, audioUrl, title);
      }

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "video/mp4");

      req.on("close", () => {
        if (ffmpegProc && !ffmpegProc.killed) {
          ffmpegProc.kill();
        }
      });

      // Pipe FFmpeg stdout directly to the HTTP response (zero buffering)
      ffmpegProc!.stdout!.pipe(res);

      let stderrBuf = "";
      ffmpegProc!.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      ffmpegProc!.on("close", (code) => {
        if (code === 0) {
          console.log(`[BACKEND DOWNLOAD] Streamed: ${filename}`);
        } else {
          console.error(`[BACKEND DOWNLOAD] FFmpeg exit ${code}: ${stderrBuf.slice(-300)}`);
          if (!res.headersSent) {
            res.status(500).send("Download failed");
          }
        }
      });

      ffmpegProc!.on("error", (err) => {
        console.error(`[BACKEND DOWNLOAD] FFmpeg error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send("Download failed");
        }
      });

    } catch (err: any) {
      console.error(`[BACKEND DOWNLOAD FAILURE] suffers exception: ${err?.message || String(err)}`);
      if (tempDir) await cleanupDirectory(tempDir);
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
        unpackWrappedJson: false,
        timeoutMs: TIMEOUT_DIRECT_MS
      },
      {
        name: "AllOrigins",
        url: `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`,
        unpackWrappedJson: true,
        timeoutMs: TIMEOUT_ALLORIGINS_MS
      },
      {
        name: "Redlib",
        url: buildRedlibListingUrl(subreddit, sort, limit, time, after),
        unpackWrappedJson: false,
        timeoutMs: TIMEOUT_REDLIB_MS
      }
    ];

    let pageChildren: any[] = [];
    let nextAfter = "";

    for (const strategy of strategies) {
      try {
        const payload = await fetchJsonPayload(strategy.url, strategy.unpackWrappedJson, strategy.timeoutMs);
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

  const mirror = REDLIB_MIRRORS[Math.floor(Math.random() * REDLIB_MIRRORS.length)];
  return `${mirror}/r/${subreddit}/${sort}.json?${params.toString()}`;
}

async function fetchJsonPayload(url: string, unpackWrappedJson: boolean, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        ...getStandardFetchHeaders(),
        // Reddit's API recommendation: <platform>:<app-id>:<version> (by /u/<reddit-username>)
        "User-Agent": `node:${REDDIT_NAME}:1.0 (by /u/scraper_bot)`
      },
      signal: controller.signal
    });

    if (response.status === 429) {
      // Surface rate-limit distinctly so the caller can fall through to the next strategy fast.
      throw new Error(`Endpoint returned HTTP 429`);
    }

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

/**
 * Run an async mapper over `items` with at most `limit` workers in flight at once.
 * Adds a small random stagger before each task starts so we don't slam Reddit with
 * a synchronized burst (which is what was triggering the 429 cascade).
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      // Per-task jitter to de-sync requests sharing the same outbound IP.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * SUBREDDIT_STAGGER_MAX_MS)
      );
      results[index] = await mapper(items[index], index);
    }
  };

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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

function buildDownloadFilename(title: string) {
  const safe = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
  return `${safe || "reddit-clip"}.mp4`;
}

function shortUrl(url: string) {
  return url.length > 80 ? `${url.slice(0, 80)}...` : url;
}

/**
 * Derive a DASH manifest URL from a v.redd.it fallback video URL when the
 * frontend didn't pass dashUrl explicitly. Reddit serves DASHPlaylist.mpd at
 * the same base path, e.g.:
 *   https://v.redd.it/abc123/DASH_720.mp4 -> https://v.redd.it/abc123/DASHPlaylist.mpd
 * Returns "" when the URL isn't a v.redd.it asset (nothing to derive).
 */
function deriveDashUrlFromVideoUrl(videoUrl: string) {
  try {
    const parsed = new URL(videoUrl);
    if (parsed.hostname !== "v.redd.it") return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    parts[parts.length - 1] = "DASHPlaylist.mpd";
    parsed.pathname = `/${parts.join("/")}`;
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "";
  }
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
  const timeoutId = setTimeout(() => controller.abort(), 120000);

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

  // Probe all candidates in parallel for speed
  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const exists = await probeRemoteFile(candidate);
      return exists ? candidate : null;
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      return result.value;
    }
  }

  return null;
}

// Moved to src/ffmpeg.ts:
//   muxVideoForDownload()  - improved with encoding, filters, subs, audio mix
//   muxVideoFromDashManifest() - improved with encoding options

async function resolveHighestQualityDashStreams(dashUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(dashUrl, {
      headers: getStandardFetchHeaders(),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Dash manifest request failed: ${response.status}`);
    }

    const manifest = await response.text();
    const manifestUrl = new URL(dashUrl);
    const representations = parseDashRepresentations(manifest, manifestUrl);

    const videoRepresentation = representations
      .filter((item) => item.kind === "video")
      .sort((a, b) => b.score - a.score)[0];
    const audioRepresentation = representations
      .filter((item) => item.kind === "audio")
      .sort((a, b) => b.score - a.score)[0];

    return {
      videoUrl: videoRepresentation?.url || "",
      audioUrl: audioRepresentation?.url || ""
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseDashRepresentations(manifest: string, manifestUrl: URL) {
  const adaptationMatches = Array.from(
    manifest.matchAll(/<AdaptationSet\b([\s\S]*?)>([\s\S]*?)<\/AdaptationSet>/gi)
  );

  return adaptationMatches.flatMap(([, adaptationAttrs, adaptationBody]) => {
    const adaptationMimeType = getXmlAttribute(adaptationAttrs, "mimeType");
    const contentType = getXmlAttribute(adaptationAttrs, "contentType");
    const kind = adaptationMimeType?.startsWith("audio") || contentType === "audio"
      ? "audio"
      : adaptationMimeType?.startsWith("video") || contentType === "video"
      ? "video"
      : null;

    if (!kind) {
      return [];
    }

    const representationMatches = Array.from(
      adaptationBody.matchAll(/<Representation\b([\s\S]*?)>([\s\S]*?)<\/Representation>/gi)
    );

    return representationMatches
      .map(([, representationAttrs, representationBody]) => {
        const baseUrlMatch = representationBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
        if (!baseUrlMatch?.[1]) {
          return null;
        }

        const bandwidth = Number(getXmlAttribute(representationAttrs, "bandwidth") || "0");
        const height = Number(getXmlAttribute(representationAttrs, "height") || "0");
        const width = Number(getXmlAttribute(representationAttrs, "width") || "0");

        return {
          kind,
          url: new URL(baseUrlMatch[1].trim(), manifestUrl).toString(),
          score: bandwidth + height * 100000 + width * 100
        };
      })
      .filter(Boolean) as Array<{ kind: "video" | "audio"; url: string; score: number }>;
  });
}

function getXmlAttribute(fragment: string, attributeName: string) {
  const match = fragment.match(new RegExp(`${attributeName}="([^"]+)"`, "i"));
  return match?.[1] || "";
}

startServer();
