import { useState } from "react";
import { 
  Film, 
  Activity, 
  Search, 
  AlertCircle,
  VideoOff,
  ListFilter,
  ChevronRight
} from "lucide-react";
import { TestRedditResponse } from "./types";
import ClipCard from "./components/ClipCard";

export default function App() {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<TestRedditResponse | null>(null);
  
  // Single active player control - memory optimization for low-end devices
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null);

  // Pagination & Filtering state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedSubFilter, setSelectedSubFilter] = useState<string>("All");
  const [visibleCount, setVisibleCount] = useState<number>(9);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  // Final commentary-focused target subreddits
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

  // Fetch from backend scraper
  const handleScrape = async () => {
    setLoading(true);
    setError(null);
    setPlayingVideoUrl(null); // reset stream memory

    try {
      const res = await fetch("/api/scrape");
      if (!res.ok) {
        throw new Error(`Server returned status code ${res.status} (${res.statusText})`);
      }
      
      const data: TestRedditResponse = await res.json();
      if (data.success) {
        setResponse(data);
        setSelectedSubFilter("All");
        setVisibleCount(9);
      } else {
        throw new Error("Backend was unable to fetch Reddit feeds");
      }
    } catch (err: any) {
      setError(err?.message || "An unexpected error occurred during direct scraping.");
    } finally {
      setLoading(false);
    }
  };

  // Client-side quick filter
  const filteredClips = response?.clips.filter((clip) => {
    const matchesSubreddit = selectedSubFilter === "All" || clip.subreddit.toLowerCase() === selectedSubFilter.toLowerCase();
    const matchesSearch = clip.title.toLowerCase().includes(searchQuery.toLowerCase()) || clip.subreddit.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSubreddit && matchesSearch;
  }) || [];

  const displayedClips = filteredClips.slice(0, visibleCount);

  // Extracted unique subreddits from response to populate filters
  const returnedSubreddits: string[] = response
    ? Array.from(new Set(response.clips.map((c) => c.subreddit as string)))
    : [];

  return (
    <div id="app_root" className="min-h-screen bg-[#0d1117] text-slate-100 flex flex-col font-sans selection:bg-[#2ea44f] selection:text-white">
      
      {/* Immersive Header */}
      <header className="border-b border-[#30363d] bg-[#161b22]/90 backdrop-blur sticky top-0 z-50 px-4 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#2ea44f]/10 border border-[#2ea44f]/30 rounded-lg">
              <Film className="w-5 h-5 text-[#2ea44f]" />
            </div>
            <div>
              <h1 id="app_header_title" className="text-base font-bold text-slate-100 tracking-tight">
                Reddit Scraper Sandbox
              </h1>
              <p className="text-[10px] text-[#8b949e] font-mono leading-none mt-0.5">
                Mode: hot 10 posts per subreddit
              </p>
            </div>
          </div>
          
          <div className="text-[10px] bg-[#0d1117] border border-[#30363d] text-[#8b949e] font-mono px-2.5 py-1 rounded hidden sm:inline-block">
            Target API: /api/scrape
          </div>
        </div>
      </header>

      {/* Desktop Subreddit Sidebar - slides left/right */}
      <div className="hidden lg:block">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          id="subreddit_sidebar_toggle"
          className="fixed left-0 top-1/2 -translate-y-1/2 z-40 bg-[#161b22] border border-[#30363d] border-l-0 p-2 rounded-r-lg hover:bg-[#30363d] transition-all cursor-pointer"
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          <ChevronRight className={`w-4 h-4 text-[#8b949e] transition-transform duration-200 ${sidebarOpen ? 'rotate-180' : ''}`} />
        </button>
        <aside
          className={`fixed left-0 top-0 h-full w-56 bg-[#161b22] border-r border-[#30363d] z-30 pt-20 transition-transform duration-300 ease-in-out ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="p-4 overflow-y-auto h-full space-y-4">
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#8b949e] mb-2">
                Target Subreddits
              </h3>
              <div className="space-y-0.5">
                <button
                  onClick={() => { setSelectedSubFilter("All"); setVisibleCount(9); }}
                  className={`w-full text-left px-3 py-2 rounded text-xs font-semibold transition-colors cursor-pointer ${
                    selectedSubFilter === "All"
                      ? "bg-[#2ea44f] text-[#0d1117]"
                      : "text-[#8b949e] hover:text-white hover:bg-[#30363d]"
                  }`}
                >
                  All
                </button>
                {TARGET_SUBREDDITS.map((sub) => (
                  <button
                    key={sub}
                    onClick={() => { setSelectedSubFilter(sub); setVisibleCount(9); }}
                    className={`w-full text-left px-3 py-2 rounded text-xs font-semibold transition-colors cursor-pointer ${
                      selectedSubFilter === sub
                        ? "bg-[#2ea44f] text-[#0d1117]"
                        : "text-[#8b949e] hover:text-white hover:bg-[#30363d]"
                    }`}
                  >
                    r/{sub}
                  </button>
                ))}
              </div>
            </div>
            {response && returnedSubreddits.length > 0 && (
              <div>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#8b949e] mb-2">
                  Found
                </h3>
                <div className="space-y-0.5">
                  {returnedSubreddits.map((sub) => (
                    <button
                      key={sub}
                      onClick={() => { setSelectedSubFilter(sub); setVisibleCount(9); }}
                      className={`w-full text-left px-3 py-2 rounded text-xs font-semibold transition-colors cursor-pointer ${
                        selectedSubFilter === sub
                          ? "bg-[#2ea44f] text-[#0d1117]"
                          : "text-[#8b949e] hover:text-white hover:bg-[#30363d]"
                      }`}
                    >
                      r/{sub}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Main Container Wrapper */}
      <main className="flex-grow max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
        
        {/* TOP: app title + subtitle */}
        <section id="banner_section" className="bg-[#161b22] border border-[#30363d] p-6 sm:p-8 rounded-xl text-center flex flex-col items-center justify-center space-y-4">
          <div className="space-y-1">
            <h1 id="main_app_title" className="text-xl sm:text-2xl md:text-3xl font-extrabold text-white tracking-tight uppercase">
              Reddit Viral Video Scraper Test
            </h1>
            <p className="text-xs sm:text-sm text-[#8b949e] max-w-xl mx-auto leading-relaxed">
              Fast lightweight scraper for hot Reddit video clips with low-overhead preview and download handling.
            </p>
          </div>

          {/* Subreddits chips visual checklist */}
          <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1 max-w-2xl">
            <span className="text-[9px] uppercase font-mono tracking-wider text-[#8b949e] mr-1">Targets:</span>
            {TARGET_SUBREDDITS.map((sub) => (
              <span 
                key={sub}
                className="bg-[#0d1117] border border-[#30363d] text-[#8b949e] text-[10px] px-2 py-0.5 rounded-md"
              >
                r/{sub}
              </span>
            ))}
          </div>

          {/* BELOW: One prominent button SCRAPE REDDIT */}
          <div className="pt-2 w-full max-w-xs">
            <button
              onClick={handleScrape}
              disabled={loading}
              id="scrape_reddit_button"
              className={`w-full py-3.5 px-6 rounded-lg text-xs font-bold uppercase tracking-widest text-[#0d1117] transition-all bg-[#2ea44f] hover:bg-[#2ea44f]/90 shadow-md ${
                loading ? "opacity-60 cursor-not-allowed" : "cursor-pointer active:scale-[0.98]"
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                {loading ? (
                  <div className="w-4 h-4 border-2 border-[#0d1117] border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Activity className="w-4 h-4" />
                )}
                <span>{loading ? "Scraping Feeds..." : "Scrape Reddit"}</span>
              </div>
            </button>
          </div>
        </section>

        {/* Loading Display */}
        {loading && (
          <div id="loading_spinner_block" className="py-20 text-center bg-[#161b22] border border-[#30363d] rounded-xl flex flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 border-4 border-[#30363d] border-t-[#2ea44f] rounded-full animate-spin" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white">Fetching Newest Reddit Clips</p>
              <p className="text-xs text-[#8b949e] max-w-sm mx-auto">
                Pulling the 10 hot posts from each target subreddit for fast raw clip scraping.
              </p>
            </div>
          </div>
        )}

        {/* Error Handling Alert */}
        {error && (
          <div id="error_alert_block" className="p-4 bg-rose-950/20 border border-rose-950/60 rounded-xl text-rose-200 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-rose-400">Scrape Attempt Interrupted</p>
              <p className="text-xs text-rose-300/90 mt-1 leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        {/* Results Output Block */}
        {response && !loading && (
          <div id="results_wrapper" className="space-y-6">
            
            {/* Scrapper Telemetry Diagnostics Row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-[#161b22] border border-[#30363d] p-4 rounded-xl flex flex-col justify-between">
                <span className="text-[10px] text-[#8b949e] font-semibold uppercase tracking-wider">Subreddits Verified</span>
                <span className="text-white text-lg font-bold font-mono mt-1">{TARGET_SUBREDDITS.length} / {TARGET_SUBREDDITS.length}</span>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] p-4 rounded-xl flex flex-col justify-between">
                <span className="text-[10px] text-[#8b949e] font-semibold uppercase tracking-wider">Scanned Posts</span>
                <span className="text-white text-lg font-bold font-mono mt-1">{response.totalFetched}</span>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] p-4 rounded-xl flex flex-col justify-between">
                <span className="text-[10px] text-[#8b949e] font-semibold uppercase tracking-wider">Videos Extracted</span>
                <span className="text-[#2ea44f] text-lg font-bold font-mono mt-1">{response.clips.length}</span>
              </div>
              <div className="bg-[#161b22] border border-[#30363d] p-4 rounded-xl flex flex-col justify-between">
                <span className="text-[10px] text-[#8b949e] font-semibold uppercase tracking-wider font-mono">Visible Clips</span>
                <span className="text-amber-500 text-lg font-bold font-mono mt-1">{displayedClips.length}</span>
              </div>
            </div>

            {/* Quick Interactive Filtering Section */}
            <div className="bg-[#161b22] border border-[#30363d] p-4 rounded-xl flex flex-col md:flex-row gap-4 items-center justify-between">
              
              {/* Filter tabs */}
              <div className="flex items-center gap-1 overflow-x-auto self-stretch md:self-auto pb-1 md:pb-0 scrollbar-none whitespace-nowrap">
                <div className="flex items-center gap-1.5 mr-2 text-[#8b949e] text-xs font-semibold shrink-0">
                  <ListFilter className="w-4 h-4 text-[#2ea44f]" />
                  <span>Filter:</span>
                </div>
                <button
                  onClick={() => {
                    setSelectedSubFilter("All");
                    setVisibleCount(9);
                  }}
                  id="tab_all_filter"
                  className={`px-3 py-1.5 rounded text-xs font-semibold uppercase transition-colors shrink-0 cursor-pointer ${
                    selectedSubFilter === "All"
                      ? "bg-[#2ea44f] text-[#0d1117]" 
                      : "text-[#8b949e] hover:text-white hover:bg-[#30363d]"
                  }`}
                >
                  All ({response.clips.length})
                </button>
                {returnedSubreddits.map((sub) => (
                  <button
                    key={sub}
                    onClick={() => {
                      setSelectedSubFilter(sub);
                      setVisibleCount(9);
                    }}
                    id={`tab_filter_${sub.toLowerCase()}`}
                    className={`px-3 py-1.5 rounded text-xs font-semibold uppercase transition-colors shrink-0 cursor-pointer ${
                      selectedSubFilter === sub
                        ? "bg-[#2ea44f] text-[#0d1117]" 
                        : "text-[#8b949e] hover:text-white hover:bg-[#30363d]"
                    }`}
                  >
                    r/{sub}
                  </button>
                ))}
              </div>

              {/* Title Search Input */}
              <div className="flex items-center gap-2 bg-[#0d1117] border border-[#30363d] px-3 py-2 rounded-lg text-slate-400 w-full md:max-w-xs focus-within:border-[#2ea44f] focus-within:text-slate-100 transition-colors">
                <Search className="w-3.5 h-3.5" />
                <input
                  type="text"
                  placeholder="Filter clips by title..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setVisibleCount(9);
                  }}
                  id="search_clips_input"
                  className="bg-transparent border-none outline-none text-xs w-full text-slate-200 placeholder-slate-500 font-medium"
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery("");
                      setVisibleCount(9);
                    }}
                    className="text-[10px] font-bold text-[#8b949e] hover:text-white"
                  >
                    CLEAR
                  </button>
                )}
              </div>
            </div>

            {/* Empty matching result list placeholder */}
            {filteredClips.length === 0 && (
              <div className="text-center py-16 bg-[#161b22] border border-[#30363d] rounded-xl space-y-2">
                <VideoOff className="w-8 h-8 text-slate-600 mx-auto" />
                <p className="text-xs font-semibold text-[#8b949e]">No clips matched your active search filters</p>
                <p className="text-[10px] text-slate-500 max-w-xs mx-auto">
                  Try clearing your search query or selecting "ALL" to inspect the complete set of matched clips.
                </p>
              </div>
            )}

            {/* Low-End friendly Virtualized HTML5 Clip Grid */}
            <div id="clips_grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
              {displayedClips.map((clip, idx) => (
                <ClipCard
                  key={`${clip.permalink}_${idx}`}
                  clip={clip}
                  index={idx}
                  isPlaying={clip.videoUrl === playingVideoUrl}
                  onPlay={() => setPlayingVideoUrl(clip.videoUrl)}
                  onPause={() => setPlayingVideoUrl(null)}
                />
              ))}
            </div>

            {/* Pagination Load More Controls */}
            {filteredClips.length > visibleCount && (
              <div id="load_more_section" className="flex justify-center pt-4 pb-8">
                <button
                  onClick={() => setVisibleCount((prev) => prev + 9)}
                  id="load_more_button"
                  className="px-6 py-3 border border-[#30363d] text-[#2ea44f] bg-[#161b22] hover:bg-[#30363d] rounded-lg text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Load More Clips (+9)
                </button>
              </div>
            )}

          </div>
        )}

        {/* Initial sandbox welcome message when feed is empty */}
        {!response && !loading && (
          <div id="welcome_blank_panel" className="text-center py-20 px-6 bg-[#161b22] border border-[#30363d] rounded-xl space-y-4">
            <div className="w-12 h-12 bg-[#2ea44f]/10 border border-[#2ea44f]/30 rounded-full flex items-center justify-center mx-auto text-[#2ea44f]">
              <Film className="w-6 h-6 animate-pulse" />
            </div>
            <div className="space-y-1 max-w-sm mx-auto">
              <h3 className="font-bold text-sm text-white">Scraper Sandbox Idle</h3>
              <p className="text-xs text-[#8b949e] leading-relaxed">
                Click the scrape button to pull the 10 hot posts from each target subreddit and prep them for fast preview and download.
              </p>
            </div>
          </div>
        )}

      </main>

      {/* Styled Footer */}
      <footer className="border-t border-[#30363d] py-6 bg-[#161b22]">
        <div className="max-w-7xl mx-auto px-4 text-center space-y-2">
          <p className="text-[10px] text-[#8b949e] font-mono leading-relaxed">
            Reddit Sandboxed Video Scraping and Streaming Verification Suite. Developed strictly with raw direct-mapping APIs.
          </p>
          <div className="flex items-center justify-center gap-3 text-[9px] text-slate-500 font-mono">
            <span>User-Agent: PART2-CF/1.0</span>
            <span>•</span>
            <span>Node Stream Proxy Port: 3000</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
