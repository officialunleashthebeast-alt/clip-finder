import { useState, type MouseEvent } from "react";
import { 
  Play, 
  ArrowUp, 
  ExternalLink, 
  VideoOff,
  X,
  Download,
  AlertTriangle,
  Loader2
} from "lucide-react";
import { RedditClip } from "../types";

interface ClipCardProps {
  key?: string | number;
  clip: RedditClip;
  index: number;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
}

export default function ClipCard({ clip, index, isPlaying, onPlay, onPause }: ClipCardProps) {
  const [imgError, setImgError] = useState<boolean>(false);
  const [videoError, setVideoError] = useState<boolean>(false);
  const [downloadState, setDownloadState] = useState<"idle" | "fetching" | "failed">("idle");

  // Helper to validate whether we should even attempt to render/load the image
  const isValidThumbnail = (url: string | undefined): boolean => {
    if (!url) return false;
    const lower = url.toLowerCase().trim();
    return (
      lower.startsWith("http") && 
      !lower.includes("self") && 
      !lower.includes("default") &&
      !lower.includes("nsfw") &&
      !lower.includes("spoiler")
    );
  };

  const showThumbnail = isValidThumbnail(clip.thumbnail) && !imgError;

  // Video proxy getter
  const getVideoSrc = (url: string | undefined): string => {
    if (!url) return "";
    return `/api/proxy-video?url=${encodeURIComponent(url)}`;
  };

  // Safe client-side proxy file download
  const handleDownload = async (e: MouseEvent) => {
    e.preventDefault();
    try {
      setDownloadState("fetching");
      const dashParam = clip.dashUrl ? `&dashUrl=${encodeURIComponent(clip.dashUrl)}` : "";
      const downloadUrl = `/api/download?url=${encodeURIComponent(clip.videoUrl)}&title=${encodeURIComponent(clip.title)}${dashParam}`;
      
      // Use fetch to download the file properly, then trigger download
      const response = await fetch(downloadUrl);
      
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }
      
      // Get the content as a blob
      const blob = await response.blob();
      
      // Create a temporary URL for the blob
      const blobUrl = URL.createObjectURL(blob);
      
      // Create a proper download link
      const helperLink = document.createElement("a");
      helperLink.href = blobUrl;
      
      // Extract filename from Content-Disposition header or build one
      const contentDisposition = response.headers.get("Content-Disposition");
      let filename = `${clip.title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 50) || 'video'}.mp4`;
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1].replace(/['"]/g, '');
        }
      }
      
      helperLink.setAttribute("download", filename);
      helperLink.style.display = "none";
      document.body.appendChild(helperLink);
      helperLink.click();
      document.body.removeChild(helperLink);
      
      // Clean up the blob URL after a short delay
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      
      setDownloadState("idle");
    } catch (err) {
      console.error(`[DOWNLOAD ACTION FAILURE] ${err}`);
      setDownloadState("failed");
      // Reset button state automatically after a delay
      setTimeout(() => setDownloadState("idle"), 4000);
    }
  };

  return (
    <article
      id={`clip_card_${index}`}
      className="bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden hover:border-[#2ea44f]/50 transition-all duration-200 flex flex-col h-full"
    >
      {/* Media Player Cover Layer */}
      <div className="relative bg-[#0d1117] aspect-video w-full shrink-0 overflow-hidden group">
        
        {/* Render lazy-loaded thumbnail ONLY if valid and not playing */}
        {showThumbnail && !isPlaying && (
          <img
            src={clip.thumbnail}
            alt={clip.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover select-none absolute inset-0 z-0 opacity-70 group-hover:opacity-60 transition-opacity duration-200"
            onError={() => {
              console.log(`Thumbnail fallback error for: ${clip.title}`);
              setImgError(true);
            }}
          />
        )}

        {/* Dynamic HTML5 Video Player Block */}
        {clip.videoUrl && !videoError ? (
          isPlaying ? (
            <div className="w-full h-full relative z-10">
              <video 
                src={getVideoSrc(clip.videoUrl)} 
                controls 
                autoPlay
                preload="none"
                playsInline
                className="w-full h-full bg-[#0d1117] object-contain"
                onError={(e) => {
                  console.warn(`Upstream streaming playback failed for: ${clip.title}`);
                  setVideoError(true);
                }}
              />
              {/* Unload control button to reclaim device memory */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onPause();
                }}
                id={`close_player_btn_${index}`}
                className="absolute top-2.5 left-2.5 z-30 p-1.5 bg-[#0d1117]/90 rounded-full border border-[#30363d] hover:bg-rose-600 hover:text-white text-slate-300 transition-all shadow-md focus:outline-none cursor-pointer"
                title="Stop Stream (Reclaim RAM)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            // Click-to-Play Interactive Placeholder Overlay
            <div 
              onClick={onPlay}
              id={`play_overlay_${index}`}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 group-hover:bg-black/50 transition-colors duration-200 cursor-pointer p-4 text-center"
            >
              <div 
                id={`play_button_icon_${index}`}
                className="w-12 h-12 bg-[#2ea44f] rounded-full flex items-center justify-center shadow-lg transform group-hover:scale-105 active:scale-95 transition-all duration-200"
              >
                <Play className="w-5 h-5 fill-[#0d1117] text-[#0d1117] ml-0.5" />
              </div>
              <span className="mt-2.5 text-[10px] font-bold text-white uppercase tracking-wider drop-shadow">
                Play Preview
              </span>
            </div>
          )
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#0d1117] p-4 text-center z-10 space-y-1.5">
            <VideoOff className="w-6 h-6 text-rose-500/80" />
            <span className="text-xs font-semibold text-rose-400">
              Preview unavailable
            </span>
          </div>
        )}

        {/* Proxy State Label */}
        {clip.videoUrl && !videoError ? (
          <div className="absolute top-2.5 right-2.5 z-20 bg-[#2ea44f]/10 text-[#2ea44f] border border-[#2ea44f]/30 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
            Proxy active
          </div>
        ) : (
          <div className="absolute top-2.5 right-2.5 z-20 bg-[#30363d]/80 text-[#8b949e] text-[9px] font-semibold px-1.5 py-0.5 rounded border border-[#30363d] uppercase">
            Offline
          </div>
        )}

        {/* Subreddit Overlaid Name Tag */}
        <span className="absolute bottom-2.5 left-2.5 z-20 bg-[#161b22]/90 backdrop-blur border border-[#30363d] text-[#2ea44f] text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wide">
          r/{clip.subreddit}
        </span>
      </div>

      {/* Meta details and triggers */}
      <div className="p-4 flex-grow flex flex-col justify-between gap-4">
        
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] font-mono text-[#8b949e]">
            <div className="flex items-center gap-1 text-amber-500">
              <ArrowUp className="w-3.5 h-3.5" />
              <span>{clip.upvotes.toLocaleString()} upvotes</span>
            </div>
            <span>•</span>
            <span>
              {new Date(clip.timestamp * 1000).toLocaleDateString()}
            </span>
          </div>

          <h3 
            id={`clip_title_${index}`}
            className="font-medium text-xs sm:text-sm leading-snug text-slate-100 line-clamp-2 hover:text-[#2ea44f] transition-colors"
          >
            {clip.title}
          </h3>
        </div>

        {/* Interactive controllers */}
        <div className="space-y-2">
          
          <div className="grid grid-cols-2 gap-2">
            {/* Play Preview Button */}
            {clip.videoUrl && !videoError && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPlaying) {
                    onPause();
                  } else {
                    onPlay();
                  }
                }}
                id={`play_btn_action_${index}`}
                className={`flex items-center justify-center gap-1 px-3 py-2.5 rounded-md text-[11px] font-bold uppercase tracking-wider cursor-pointer border transition-colors ${
                  isPlaying 
                    ? "bg-[#30363d] text-[#8b949e] border-[#30363d]" 
                    : "bg-transparent text-[#2ea44f] hover:bg-[#2ea44f]/10 border-[#2ea44f]/25"
                }`}
              >
                {isPlaying ? <X className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{isPlaying ? "Close" : "Play Preview"}</span>
              </button>
            )}

            {/* Direct Proxy Download Button */}
            {clip.videoUrl && (
              <button
                onClick={handleDownload}
                disabled={downloadState === "fetching"}
                id={`download_btn_${index}`}
                className={`flex items-center justify-center gap-1 px-3 py-2.5 rounded-md text-[11px] font-bold uppercase tracking-wider cursor-pointer transition-colors border ${
                  downloadState === "fetching"
                    ? "bg-[#30363d] text-[#8b949e] border-[#30363d] cursor-not-allowed"
                    : downloadState === "failed"
                    ? "bg-rose-950/40 text-rose-400 border-rose-500/30"
                    : "bg-[#2ea44f] hover:bg-[#2ea44f]/95 text-white border-transparent"
                }`}
              >
                {downloadState === "fetching" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8b949e]" />
                ) : downloadState === "failed" ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>
                  {downloadState === "fetching" 
                    ? "Loading..." 
                    : downloadState === "failed" 
                    ? "Download failed" 
                    : "Download"}
                </span>
              </button>
            )}
          </div>

          {/* Open Reddit link */}
          <a
            href={clip.permalink}
            target="_blank"
            rel="noreferrer noopener"
            id={`open_reddit_btn_${index}`}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-md text-[11px] font-semibold text-[#8b949e] select-none hover:text-white bg-[#0d1117] hover:bg-black/40 border border-[#30363d] transition-colors uppercase tracking-wide cursor-pointer"
          >
            <span>Open Reddit Post</span>
            <ExternalLink className="w-3 h-3 text-[#8b949e]" />
          </a>

        </div>

      </div>
    </article>
  );
}
