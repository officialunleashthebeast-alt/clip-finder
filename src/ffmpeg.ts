import { execFile, execFileSync } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import { Readable } from "stream";
import { finished } from "stream/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ============================================================
// Types
// ============================================================

export interface QualityPreset {
  codec: "h264" | "h265" | "vp9" | "av1";
  crf: number;
  preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
  tune?: "film" | "animation" | "grain" | "stillimage" | "fastdecode" | "zerolatency" | "psnr" | "ssim";
  profile?: "baseline" | "main" | "high" | "high10" | "high422" | "high444";
  maxResolution?: { width: number; height: number };
  targetFps?: number;
}

export interface ClipSegment {
  sourcePath: string;
  startTime?: number;
  endTime?: number;
  transition?: {
    type: "crossfade" | "fade" | "dissolve" | "wipe" | "none";
    duration: number;
  };
  speed?: number;
  filters?: VideoFilter[];
}

export interface VideoFilter {
  type: "scale" | "crop" | "fadeIn" | "fadeOut" | "text" | "speed" | "rotate" | "colorGrade" | "sharpen" | "blur";
  params: Record<string, string | number>;
}

export interface SubtitleTrack {
  srtContent: string;
  style?: {
    fontName?: string;
    fontSize?: number;
    primaryColor?: string;
    outlineColor?: string;
    position?: "bottom" | "top" | "middle";
    marginV?: number;
  };
}

export interface AudioOverlay {
  sourcePath: string;
  volume?: number;
  offset?: number;
  mixMethod?: "overlay" | "replace" | "duck";
}

export interface EditingPlan {
  clips: ClipSegment[];
  outputPath: string;
  subtitles?: SubtitleTrack;
  voiceover?: AudioOverlay;
  backgroundMusic?: AudioOverlay;
  quality?: Partial<QualityPreset>;
  title?: string;
}

export interface FormatProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  bitrate: number;
  isHDR: boolean;
  rotation: number;
}

// ============================================================
// Constants
// ============================================================

export const QUALITY_PRESETS = {
  "source": { codec: "h264", crf: 0, preset: "medium", tune: "film", profile: "high444" } as QualityPreset,
  "master": { codec: "h264", crf: 14, preset: "slow", tune: "film", profile: "high" } as QualityPreset,
  "high": { codec: "h264", crf: 18, preset: "medium", profile: "high" } as QualityPreset,
  "balanced": { codec: "h264", crf: 23, preset: "medium", profile: "main" } as QualityPreset,
  "fast": { codec: "h264", crf: 28, preset: "veryfast", profile: "main" } as QualityPreset,
} as const;

// ============================================================
// Helpers
// ============================================================

function buildCodecArgs(codec: QualityPreset["codec"], crf: number, preset: QualityPreset["preset"], tune?: string, profile?: string): string[] {
  const encoderMap: Record<string, string> = {
    h264: "libx264",
    h265: "libx265",
    vp9: "libvpx-vp9",
    av1: "libaom-av1",
  };

  const encoder = encoderMap[codec] || "libx264";
  const args = ["-c:v", encoder];

  if (codec === "h264" || codec === "h265") {
    if (crf >= 0) args.push("-crf", String(crf));
    args.push("-preset", preset);
    if (tune) args.push("-tune", tune);
    if (profile) args.push("-profile:v", profile);
  } else if (codec === "vp9") {
    args.push("-crf", String(Math.max(0, Math.min(63, crf + 15))));
    if (preset === "ultrafast" || preset === "superfast" || preset === "veryfast") args.push("-speed", "4");
    else if (preset === "faster" || preset === "fast") args.push("-speed", "2");
    else if (preset === "medium") args.push("-speed", "1");
    else args.push("-speed", "0");
  } else if (codec === "av1") {
    args.push("-crf", String(Math.max(0, Math.min(63, crf + 15))));
    args.push("-cpu-used", preset === "ultrafast" ? "6" : preset === "superfast" ? "5" : preset === "veryfast" ? "4" : "2");
  }

  args.push("-pix_fmt", "yuv420p");
  return args;
}

function buildEncoderFlags(codec: QualityPreset["codec"]): string[] {
  if (codec === "h264") return ["-movflags", "+faststart"];
  return [];
}

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `reddit-vid-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function ffmpegTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function buildFiltersForSegment(segment: ClipSegment, inputLabel = "0", outputIndex = 0): string[] {
  const chains: string[] = [];
  let currentChain = `[${inputLabel}:v]`;

  if (segment.filters) {
    for (const f of segment.filters) {
      switch (f.type) {
        case "scale": {
          const w = f.params.width || -1;
          const h = f.params.height || -1;
          currentChain += `scale=${w}:${h}:flags=lanczos,setsar=1:1`;
          break;
        }
        case "crop": {
          const w = f.params.width;
          const h = f.params.height;
          const x = f.params.x ?? "(iw-ow)/2";
          const y = f.params.y ?? "(ih-oh)/2";
          currentChain += `crop=${w}:${h}:${x}:${y}`;
          break;
        }
        case "fadeIn": {
          const d = f.params.duration ?? 0.5;
          const c = f.params.color ?? "black";
          currentChain += `fade=t=in:st=0:d=${d}:color=${c}`;
          break;
        }
        case "fadeOut": {
          const d = f.params.duration ?? 0.5;
          const c = f.params.color ?? "black";
          currentChain += `fade=t=out:st=${d}:d=${d}:color=${c}`;
          break;
        }
        case "sharpen": {
          const strength = f.params.strength ?? 1.2;
          currentChain += `unsharp=${strength}:${strength}:1.5:${strength}:${strength}:1.5`;
          break;
        }
        case "blur": {
          const r = f.params.radius ?? 5;
          currentChain += `boxblur=${r}:${r}`;
          break;
        }
        case "rotate": {
          const angle = f.params.angle ?? 0;
          currentChain += `rotate=${angle}*PI/180:fill=black`;
          break;
        }
        case "text": {
          const text = f.params.text ?? "";
          const x = f.params.x ?? "(w-text_w)/2";
          const y = f.params.y ?? "h-th-30";
          const size = f.params.fontSize ?? 24;
          const color = f.params.color ?? "white";
          currentChain += `drawtext=text='${text}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:fontfile=/Windows/Fonts/Arial.ttf`;
          break;
        }
        case "colorGrade": {
          const brightness = f.params.brightness ?? 0;
          const contrast = f.params.contrast ?? 1.0;
          const saturation = f.params.saturation ?? 1.0;
          currentChain += `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`;
          break;
        }
      }
      currentChain += ",";
    }
  }

  if (currentChain.endsWith(",")) {
    currentChain = currentChain.slice(0, -1);
    currentChain += `[v${outputIndex}]`;
    return [currentChain];
  }

  return [];
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

async function writeSrtFile(srtContent: string, outputPath: string): Promise<void> {
  await fs.writeFile(outputPath, srtContent, "utf-8");
}

// ============================================================
// Probe
// ============================================================

export async function probeFormat(inputPath: string): Promise<FormatProbe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ], { windowsHide: true, timeout: 15000 });

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((s: any) => s.codec_type === "video");
  const audioStream = data.streams?.find((s: any) => s.codec_type === "audio");

  return {
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name || "unknown",
    audioCodec: audioStream?.codec_name || "none",
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    fps: parseInt(videoStream?.avg_frame_rate?.split("/")[0]) / parseInt(videoStream?.avg_frame_rate?.split("/")[1]) || 0,
    duration: parseFloat(data.format?.duration || "0"),
    bitrate: parseInt(data.format?.bit_rate || "0"),
    isHDR: videoStream?.color_transfer === "smpte2084" || videoStream?.color_primaries === "bt2020",
    rotation: parseInt(videoStream?.side_data_list?.[0]?.rotation || videoStream?.tags?.rotate || "0"),
  };
}

// ============================================================
// Transcode single file
// ============================================================

export interface TranscodeOptions {
  quality?: Partial<QualityPreset>;
  resolution?: { width: number; height: number };
  startTime?: number;
  duration?: number;
  audioFilter?: string;
  videoFilters?: string[];
  outputPrefix?: string;
}

export async function transcodeVideo(input: string, output: string, opts: TranscodeOptions = {}): Promise<void> {
  const quality: QualityPreset = { ...QUALITY_PRESETS.balanced, ...opts.quality };
  const args: string[] = ["-y"];

  if (opts.startTime !== undefined) args.push("-ss", ffmpegTime(opts.startTime));
  if (opts.duration !== undefined) args.push("-t", ffmpegTime(opts.duration));

  args.push("-i", input);

  const filterChain: string[] = [...(opts.videoFilters || [])];

  if (opts.resolution) {
    filterChain.push(`scale=${opts.resolution.width}:${opts.resolution.height}:flags=lanczos,setsar=1:1`);
  }

  if (filterChain.length > 0) {
    args.push("-vf", filterChain.join(","));
  }

  args.push(...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile));
  if (opts.audioFilter) {
    args.push("-af", opts.audioFilter);
  }
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push(...buildEncoderFlags(quality.codec));
  args.push(output);

  const { stderr } = await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 180000 });
  const durationMs = parseDurationFromOutput(stderr);
  if (durationMs > 0) {
    console.log(`[FFMPEG] Transcode complete: ${path.basename(output)} (${(durationMs / 1000).toFixed(1)}s)`);
  }
}

// ============================================================
// Subtitle burning (SRT)
// ============================================================

export interface SubtitleOptions {
  srtContent: string;
  style?: SubtitleTrack["style"];
  quality?: Partial<QualityPreset>;
  resolution?: { width: number; height: number };
}

export async function burnSubtitles(input: string, output: string, opts: SubtitleOptions): Promise<void> {
  const tempDir = await makeTempDir();
  try {
    const srtPath = path.join(tempDir, "subtitles.srt");
    await writeSrtFile(opts.srtContent, srtPath);

    const quality: QualityPreset = { ...QUALITY_PRESETS.balanced, ...opts.quality };

    const style = opts.style || {};
    const fontSize = style.fontSize || 22;
    const fontColor = style.primaryColor || "white";
    const outlineColor = style.outlineColor || "black";
    const marginV = style.marginV ?? 40;
    const posY = style.position === "top" ? `h-text_h-${marginV}` : `h-${marginV}`;
    const fontName = style.fontName || "Arial";

    const subtitleFilter = `subtitles=${escapeFilterPath(srtPath)}:force_style='FontName=${fontName},FontSize=${fontSize},PrimaryColour=&H${fontColor.replace("#", "")}&,OutlineColour=&H${outlineColor.replace("#", "")}&,MarginV=${marginV}'`;
    const scaleFilter = opts.resolution ? `scale=${opts.resolution.width}:${opts.resolution.height}:flags=lanczos,setsar=1:1,` : "";
    const fullFilter = `${scaleFilter}${subtitleFilter}`;

    const args: string[] = [
      "-y", "-i", input,
      "-vf", fullFilter,
      ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
      "-c:a", "aac", "-b:a", "192k",
      ...buildEncoderFlags(quality.codec),
      output,
    ];

    await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 180000 });
    console.log(`[FFMPEG] Subtitles burned: ${path.basename(output)}`);
  } finally {
    await cleanupDir(tempDir);
  }
}

// ============================================================
// Audio mixing (voiceover / background music)
// ============================================================

export interface AudioMixOptions {
  voiceover?: AudioOverlay;
  backgroundMusic?: AudioOverlay;
  quality?: Partial<QualityPreset>;
}

export async function mixAudio(inputVideo: string, output: string, opts: AudioMixOptions): Promise<void> {
  const quality: QualityPreset = { ...QUALITY_PRESETS.balanced, ...opts.quality };

  const inputs: string[] = [inputVideo];
  const filterInputs: string[] = ["[0:a]"];

  let overlayCount = 0;

  const addOverlay = (overlay: AudioOverlay, label: string) => {
    const volFactor = overlay.volume ?? 1.0;
    if (overlay.sourcePath) {
      inputs.push(overlay.sourcePath);
      filterInputs.push(`[${overlayCount + 1}:a]volume=${volFactor}[a${label}]`);
      overlayCount++;
    }
  };

  const mixInputs: string[] = [];

  // Original audio stream
  mixInputs.push("[0:a]");

  if (opts.voiceover?.sourcePath) {
    const vol = opts.voiceover.volume ?? 1.0;
    inputs.push(opts.voiceover.sourcePath);
    const delayFilter = opts.voiceover.offset && opts.voiceover.offset > 0
      ? `adelay=${(opts.voiceover.offset * 1000).toFixed(0)}|${(opts.voiceover.offset * 1000).toFixed(0)},`
      : "";
    filterInputs.push(`[${overlayCount + 1}:a]${delayFilter}volume=${vol}[avoice]`);
    mixInputs.push("[avoice]");
    overlayCount++;
  }

  if (opts.backgroundMusic?.sourcePath) {
    const vol = opts.backgroundMusic.volume ?? 0.3;
    inputs.push(opts.backgroundMusic.sourcePath);
    const delayFilter = opts.backgroundMusic.offset && opts.backgroundMusic.offset > 0
      ? `adelay=${(opts.backgroundMusic.offset * 1000).toFixed(0)}|${(opts.backgroundMusic.offset * 1000).toFixed(0)},`
      : "";
    filterInputs.push(`[${overlayCount + 1}:a]${delayFilter}volume=${vol}[amusic]`);
    mixInputs.push("[amusic]");
    overlayCount++;
  }

  const args: string[] = ["-y", ...inputs.flatMap(i => ["-i", i])];

  // Build audio filter
  if (overlayCount > 0) {
    const amixInputs = mixInputs.join("");
    const amixDuration = opts.voiceover?.mixMethod === "replace" ? "first" : "longest";
    args.push("-filter_complex", `${amixInputs}amix=inputs=${mixInputs.length}:duration=${amixDuration}:dropout_transition=2[audio]`);
    args.push("-map", "0:v:0", "-map", "[audio]");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0");
  }

  args.push(
    ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
    "-c:a", "aac", "-b:a", "192k",
    ...buildEncoderFlags(quality.codec),
    output,
  );

  await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 300000 });
  console.log(`[FFMPEG] Audio mix complete: ${path.basename(output)}`);
}

// ============================================================
// Clip concatenation with transitions
// ============================================================

export interface ConcatOptions {
  segments: ClipSegment[];
  quality?: Partial<QualityPreset>;
  resolution?: { width: number; height: number };
}

export async function concatClips(output: string, opts: ConcatOptions): Promise<void> {
  const { segments, quality: qOpts } = opts;
  if (segments.length === 0) throw new Error("No segments to concatenate");
  if (segments.length === 1) {
    const seg = segments[0];
    await transcodeVideo(seg.sourcePath, output, {
      quality: qOpts,
      startTime: seg.startTime,
      duration: seg.endTime ? seg.endTime - (seg.startTime || 0) : undefined,
      resolution: opts.resolution,
    });
    return;
  }

  const quality: QualityPreset = { ...QUALITY_PRESETS.balanced, ...qOpts };
  const tempDir = await makeTempDir();

  try {
    // Pre-process each segment to consistent format
    const segPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segOut = path.join(tempDir, `seg_${i}.mp4`);
      await transcodeVideo(seg.sourcePath, segOut, {
        quality,
        startTime: seg.startTime,
        duration: seg.endTime ? seg.endTime - (seg.startTime || 0) : undefined,
        resolution: opts.resolution,
      });
      segPaths.push(segOut);
    }

    // Check if we need transitions
    const hasTransitions = segments.some(s => s.transition && s.transition.type !== "none" && s.transition.duration > 0);

    if (hasTransitions && segments.length === 2) {
      // Use crossfade for simple 2-clip case
      const t1 = segments[0].transition || segments[1].transition || { type: "crossfade", duration: 0.5 };
      const dur = t1.duration;

      // Probe first segment for duration
      const probe1 = await probeFormat(segPaths[0]);
      const dur1 = probe1.duration;

      await execFileAsync("ffmpeg", [
        "-y",
        "-i", segPaths[0],
        "-i", segPaths[1],
        "-filter_complex",
        `[0:v]settb=AVTB,fade=t=out:st=${Math.max(0, dur1 - dur)}:d=${dur}:color=black[v0];` +
        `[1:v]settb=AVTB,fade=t=in:st=0:d=${dur}:color=black[v1];` +
        `[v0][v1]concat=n=2:v=1:a=0[video];` +
        `[0:a]afade=t=out:st=${Math.max(0, dur1 - dur)}:d=${dur}[a0];` +
        `[1:a]afade=t=in:st=0:d=${dur}[a1];` +
        `[a0][a1]amix=inputs=2:duration=first[audio]`,
        "-map", "[video]", "-map", "[audio]",
        ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
        "-c:a", "aac", "-b:a", "192k",
        ...buildEncoderFlags(quality.codec),
        output,
      ], { windowsHide: true, timeout: 300000 });
    } else {
      // Use concat demuxer for simple joins
      const concatFile = path.join(tempDir, "concat.txt");
      const concatContent = segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      await fs.writeFile(concatFile, concatContent, "utf-8");

      await execFileAsync("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0",
        "-i", concatFile,
        "-map", "0:v:0", "-map", "0:a:0",
        ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
        "-c:a", "aac", "-b:a", "192k",
        ...buildEncoderFlags(quality.codec),
        output,
      ], { windowsHide: true, timeout: 300000 });
    }

    console.log(`[FFMPEG] Concat complete: ${path.basename(output)} (${segments.length} segments)`);
  } finally {
    await cleanupDir(tempDir);
  }
}

// ============================================================
// Full editing plan execution
// ============================================================

export async function executeEditingPlan(plan: EditingPlan): Promise<void> {
  const tempDir = await makeTempDir();
  try {
    let currentInput: string;

    // Step 1: Concatenate clips if needed
    if (plan.clips.length === 0) {
      throw new Error("Editing plan must have at least one clip");
    }

    if (plan.clips.length === 1) {
      const seg = plan.clips[0];
      currentInput = path.join(tempDir, "concat.mp4");
      await transcodeVideo(seg.sourcePath, currentInput, {
        quality: plan.quality,
        startTime: seg.startTime,
        duration: seg.endTime ? seg.endTime - (seg.startTime || 0) : undefined,
        videoFilters: seg.filters?.map(f => `${f.type}=${Object.entries(f.params).map(([k, v]) => `${k}=${v}`).join(":")}`),
        resolution: undefined,
      });
    } else {
      currentInput = path.join(tempDir, "concat.mp4");
      await concatClips(currentInput, {
        segments: plan.clips,
        quality: plan.quality,
      });
    }

    // Step 2: Burn subtitles
    let subsInput = currentInput;
    if (plan.subtitles) {
      const subsOutput = path.join(tempDir, "subs.mp4");
      await burnSubtitles(subsInput, subsOutput, {
        srtContent: plan.subtitles.srtContent,
        style: plan.subtitles.style,
        quality: plan.quality,
      });
      subsInput = subsOutput;
    }

    // Step 3: Mix audio
    let audioInput = subsInput;
    if (plan.voiceover || plan.backgroundMusic) {
      const audioOutput = path.join(tempDir, "audio.mp4");
      await mixAudio(audioInput, audioOutput, {
        voiceover: plan.voiceover,
        backgroundMusic: plan.backgroundMusic,
        quality: plan.quality,
      });
      audioInput = audioOutput;
    }

    // Step 4: Final delivery
    if (audioInput !== plan.outputPath) {
      await fs.copyFile(audioInput, plan.outputPath);
    }

    // Add metadata if title is provided
    if (plan.title) {
      const metaOutput = path.join(tempDir, "meta.mp4");
      await execFileAsync("ffmpeg", [
        "-y", "-i", plan.outputPath,
        "-c", "copy",
        "-metadata", `title=${plan.title}`,
        "-metadata", `comment=Generated by Reddit Video Engine`,
        metaOutput,
      ], { windowsHide: true, timeout: 60000 });
      await fs.copyFile(metaOutput, plan.outputPath);
    }

    console.log(`[FFMPEG] Editing plan complete: ${path.basename(plan.outputPath)}`);
  } finally {
    await cleanupDir(tempDir);
  }
}

// ============================================================
// Improved mux functions (drop-in replacement for old ones)
// ============================================================

export interface MuxOptions {
  audioInputPath?: string | null;
  title?: string;
  quality?: Partial<QualityPreset>;
  resolution?: { width: number; height: number };
  subtitles?: SubtitleTrack;
  voiceover?: AudioOverlay;
  backgroundMusic?: AudioOverlay;
}

export async function muxVideoForDownload(videoInputPath: string, outputPath: string, opts: MuxOptions = {}): Promise<void> {
  const quality: QualityPreset = { ...QUALITY_PRESETS.high, ...opts.quality };

  const args: string[] = ["-y", "-i", videoInputPath];

  // Build filter complex
  const filterParts: string[] = [];
  let videoLabel = "0:v:0";
  let audioLabel = "0:a:0";
  let hasComplexFilter = false;

  if (opts.resolution) {
    filterParts.push(`scale=${opts.resolution.width}:${opts.resolution.height}:flags=lanczos,setsar=1:1`);
  }

  if (opts.subtitles?.srtContent) {
    const tempDir = await makeTempDir();
    try {
      const srtPath = path.join(tempDir, "subs.srt");
      await writeSrtFile(opts.subtitles.srtContent, srtPath);
      const style = opts.subtitles.style || {};
      const fontSize = style.fontSize || 22;
      const fontColor = style.primaryColor || "white";
      const outlineColor = style.outlineColor || "black";
      const marginV = style.marginV ?? 40;
      const fontName = style.fontName || "Arial";
      filterParts.push(`subtitles=${escapeFilterPath(srtPath)}:force_style='FontName=${fontName},FontSize=${fontSize},PrimaryColour=&H${fontColor.replace("#", "")}&,OutlineColour=&H${outlineColor.replace("#", "")}&,MarginV=${marginV}'`);
    } finally {
      // Don't cleanup here - filter will reference file during encoding
    }
  }

  if (filterParts.length > 0) {
    args.push("-vf", filterParts.join(","));
  }

  // Handle separate audio input (Reddit videos often have separate audio)
  if (opts.audioInputPath) {
    args.push("-i", opts.audioInputPath);
    // Video is input 0, audio is input 1 - use [1:a] for audio since video has no audio
    const amix = "[1:a]anull[audio]";
    args.push("-filter_complex", amix);
    args.push("-map", "[audio]");
    audioLabel = "";
  } else if (opts.voiceover?.sourcePath) {
    const vol = opts.voiceover.volume ?? 1.0;
    args.push("-i", opts.voiceover.sourcePath);
    const offsetMs = opts.voiceover.offset ? (opts.voiceover.offset * 1000).toFixed(0) : "0";
    const ads = `adelay=${offsetMs}|${offsetMs}`;
    const amix = `[0:a]${ads},volume=${vol}[voiced];[1:a]amix=inputs=2:duration=first[audio]`;
    args.push("-filter_complex", amix);
    args.push("-map", "[audio]");
    audioLabel = "";
  } else if (opts.backgroundMusic?.sourcePath) {
    const vol = opts.backgroundMusic.volume ?? 0.3;
    args.push("-i", opts.backgroundMusic.sourcePath);
    const offsetMs = opts.backgroundMusic.offset ? (opts.backgroundMusic.offset * 1000).toFixed(0) : "0";
    const ads = `adelay=${offsetMs}|${offsetMs}`;
    const amix = `[0:a]${ads},volume=${vol}[bga];[1:a]amix=inputs=2:duration=first[audio]`;
    args.push("-filter_complex", amix);
    args.push("-map", "[audio]");
    audioLabel = "";
  }

  args.push(
    "-map", videoLabel,
  );

  // Use optional audio map (?) to handle videos without audio streams
  if (audioLabel) {
    args.push("-map", audioLabel + "?");
  }

  args.push(
    ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
    "-c:a", "aac", "-b:a", "192k",
    ...buildEncoderFlags(quality.codec),
  );

  if (opts.title) {
    args.push("-metadata", `title=${opts.title}`);
  }

  args.push(outputPath);

  const { stderr } = await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 300000 });
  const durationMs = parseDurationFromOutput(stderr);
  console.log(`[FFMPEG] Mux complete: ${path.basename(outputPath)}${durationMs > 0 ? ` (${(durationMs / 1000).toFixed(1)}s)` : ""}`);
}

export async function muxVideoFromDashManifest(dashUrl: string, outputPath: string, opts: { title?: string; quality?: Partial<QualityPreset> } = {}): Promise<void> {
  const quality: QualityPreset = { ...QUALITY_PRESETS.high, ...opts.quality };

  const args: string[] = [
    "-y",
    "-user_agent", "RedditVideoEngine/1.0",
    "-headers", "Referer: https://www.reddit.com/\r\nAccept-Language: en-US,en;q=0.9\r\n",
    "-i", dashUrl,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    ...buildCodecArgs(quality.codec, quality.crf, quality.preset, quality.tune, quality.profile),
    "-c:a", "aac", "-b:a", "192k",
    ...buildEncoderFlags(quality.codec),
  ];

  if (opts.title) {
    args.push("-metadata", `title=${opts.title}`);
  }

  args.push(outputPath);

  await execFileAsync("ffmpeg", args, { windowsHide: true, timeout: 180000 });
  console.log(`[FFMPEG] DASH mux complete: ${path.basename(outputPath)}`);
}

// ============================================================
// Download with full editing pipeline
// ============================================================

export interface DownloadOptions {
  videoUrl: string;
  audioUrl?: string | null;
  title?: string;
  quality?: Partial<QualityPreset>;
  subtitles?: SubtitleTrack;
  voiceover?: AudioOverlay;
  backgroundMusic?: AudioOverlay;
  resolution?: { width: number; height: number };
}

export async function downloadAndProcess(options: DownloadOptions): Promise<string> {
  const tempDir = await makeTempDir();
  const videoPath = path.join(tempDir, "source_video.mp4");
  const audioPath = path.join(tempDir, "source_audio.mp4");
  const outputPath = path.join(tempDir, "output.mp4");

  try {
    // Download video
    console.log(`[FFMPEG] Downloading video from: ${options.videoUrl.substring(0, 60)}...`);
    const videoResp = await fetch(options.videoUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.reddit.com/",
      },
    });
    if (!videoResp.ok || !videoResp.body) throw new Error(`Video download failed: ${videoResp.status}`);
    const vStream = createWriteStream(videoPath);
    const vReader = Readable.fromWeb(videoResp.body as any);
    vReader.pipe(vStream);
    await finished(vStream);

    // Download audio if separate
    let hasAudio = false;
    if (options.audioUrl) {
      console.log(`[FFMPEG] Downloading audio track...`);
      const audioResp = await fetch(options.audioUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.reddit.com/",
        },
      });
      if (audioResp.ok && audioResp.body) {
        const aStream = createWriteStream(audioPath);
        const aReader = Readable.fromWeb(audioResp.body as any);
        aReader.pipe(aStream);
        await finished(aStream);
        hasAudio = true;
      }
    }

    // Mux with all processing
    await muxVideoForDownload(videoPath, outputPath, {
      audioInputPath: hasAudio ? audioPath : null,
      title: options.title,
      quality: options.quality,
      resolution: options.resolution,
      subtitles: options.subtitles,
      voiceover: options.voiceover,
      backgroundMusic: options.backgroundMusic,
    });

    return outputPath;
  } catch (err) {
    await cleanupDir(tempDir);
    throw err;
  }
}

// ============================================================
// Helpers
// ============================================================

function parseDurationFromOutput(stderr: string): number {
  const match = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (match) {
    return parseInt(match[1]) * 3600000 + parseInt(match[2]) * 60000 + parseFloat(match[3]) * 1000;
  }
  return 0;
}
