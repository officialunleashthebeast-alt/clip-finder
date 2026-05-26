# Reddit Scraper Test App — Frontend Structure for Playwright Automation

## Stack
React 19 + Vite + Tailwind CSS 4 + Express backend. Single-page app (no router), port 3000, mount `#root`.

---

## 1. Page Layout (all state-driven, single `/` URL)

| Section | Visibility | Key Selector |
|---|---|---|
| Header | Always | `#app_root > header` (sticky, `z-50`) |
| Welcome panel | `!response && !loading` | `#welcome_blank_panel` |
| Scrape banner | Always | `#banner_section` |
| Loading spinner | `loading === true` | `#loading_spinner_block` |
| Error alert | `error !== null` | `#error_alert_block` |
| Results dashboard | `response && !loading` | `#results_wrapper` |
| Clips grid | Within results | `#clips_grid` |
| Load more | `filteredClips.length > visibleCount` | `#load_more_section` / `#load_more_button` |
| Desktop sidebar | `>= 1024px` | `#subreddit_sidebar_toggle` + `<aside>` |
| Footer | Always | `footer` |

---

## 2. Header (`<header>`)

| Element | ID | Selector |
|---|---|---|
| App title | `#app_header_title` | `#app_header_title` |
| Subtitle | — | `text=Mode: hot 10 posts per subreddit` |
| API badge | — | `text=Target API: /api/scrape` |

---

## 3. Scrape Banner (`#banner_section`)

| Element | ID / Selector |
|---|---|
| Title | `#main_app_title` → text `"Reddit Viral Video Scraper Test"` |
| Description | `text=Fast lightweight scraper` |
| Scrape button | `#scrape_reddit_button` |
| Scrape button idle | text `"Scrape Reddit"`, `cursor-pointer` |
| Scrape button loading | text `"Scraping Feeds..."`, `disabled`, `opacity-60 cursor-not-allowed` |

---

## 4. Desktop Subreddit Sidebar (≥1024px)

| Element | ID / Selector |
|---|---|
| Toggle button | `#subreddit_sidebar_toggle` |
| Sidebar panel | `aside` (fixed left) |
| Section title | `text=Target Subreddits` |
| "All" filter | `text=All` (button) |
| Subreddit buttons (20) | `text=r/PublicFreakout` etc. |

---

## 5. Loading State (`#loading_spinner_block`)

- Spinner div with `animate-spin`
- Title: `"Fetching Newest Reddit Clips"`
- Subtitle: `"Pulling the 10 hot posts from each target subreddit..."`

---

## 6. Error State (`#error_alert_block`)

- Heading: `"Scrape Attempt Interrupted"`
- Dynamic error message

---

## 7. Results Dashboard (`#results_wrapper`)

### 7a. Telemetry Cards

| Metric | Text pattern |
|---|---|
| Subreddits Verified | `text=Subreddits Verified` (always 20/20) |
| Scanned Posts | `text=Scanned Posts` |
| Videos Extracted | `text=Videos Extracted` |
| Visible Clips | `text=Visible Clips` |

### 7b. Filter Section

| Element | ID / Selector |
|---|---|
| Filter label | `text=Filter:` |
| "All" tab | `#tab_all_filter` |
| Subreddit tabs | `#tab_filter_{lowercased_subreddit}` (e.g. `#tab_filter_crazyfuckingvideos`) |
| Search input | `#search_clips_input` (placeholder: `"Filter clips by title..."`) |
| Clear button | `text=CLEAR` (only when `searchQuery` non-empty) |

### 7c. Empty Results

- Icon: `VideoOff`
- Text: `"No clips matched your active search filters"`
- Hint: `"Try clearing your search query..."`

### 7d. Clips Grid (`#clips_grid`)

CSS: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
Each card = `<ClipCard>` inside `<article id="clip_card_{index}">`

### 7e. Load More (`#load_more_section`)

| Element | ID | Text |
|---|---|---|
| Button | `#load_more_button` | `"Load More Clips (+9)"` |

Increments `visibleCount` by 9. Shown when `filteredClips.length > visibleCount`.

---

## 8. Clip Card — `#clip_card_{index}`

### 8a. Media Area

| Element | ID / Selector |
|---|---|
| Thumbnail img | `#clip_card_{index} img` |
| Play overlay | `#play_overlay_{index}` |
| Play icon | `#play_button_icon_{index}` |
| Play label | `text=Play Preview` |
| Video player | `#clip_card_{index} video` (src: `/api/proxy-video?url=...`) |
| Close player btn | `#close_player_btn_{index}` |
| Proxy badge | `text=Proxy active` or `text=Offline` |
| Subreddit tag | `text=r/{subreddit}` |

### 8b. Metadata

| Element | ID / Selector |
|---|---|
| Upvotes | `text={upvotes.toLocaleString()} upvotes` |
| Date | formatted from `clip.timestamp` |
| Title | `#clip_title_{index}` (line-clamp-2) |

### 8c. Action Buttons

| Button | ID | States |
|---|---|---|
| Play Preview / Close | `#play_btn_action_{index}` | `"Play Preview"` (green border) / `"Close"` (grey, when playing) |
| Download | `#download_btn_{index}` | **idle:** green bg, `"Download"` + Download icon / **fetching:** grey disabled `"Loading..."` + spinner / **failed:** rose bg `"Download failed"` + warning icon (resets 4s) |
| Open Reddit Post | `#open_reddit_btn_{index}` | `<a>` link, opens `clip.permalink` in new tab |

### 8d. Download Flow

1. Clicks `#download_btn_{index}`
2. Creates temp `<a download>` pointing to `/api/download?url={encoded videoUrl}&title={encoded title}&dashUrl={encoded dashUrl}`
3. Triggers native browser download
4. **In Playwright:** capture with `page.waitForEvent('download')`

### 8e. Error / Offline State

If `videoError` or `!clip.videoUrl`:
- `VideoOff` icon (rose)
- Text: `"Preview unavailable"` (rose)

---

## 9. Welcome Panel (`#welcome_blank_panel`)

- Film icon (pulsing green)
- Heading: `"Scraper Sandbox Idle"`
- Text: `"Click the scrape button to pull the 10 hot posts..."`

---

## 10. Footer

- `"Reddit Sandboxed Video Scraping and Streaming Verification Suite..."`
- `"User-Agent: PART2-CF/1.0"`
- `"Node Stream Proxy Port: 3000"`

---

## 11. API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/scrape` | GET | Scrape all 20 subreddits → returns `TestRedditResponse` JSON |
| `/api/proxy-video?url={encoded}` | GET | Proxies video stream with range support |
| `/api/download?url={}&title={}&dashUrl={}` | GET | Downloads + muxes video → `.mp4` attachment |

---

## 12. Subreddit Targets (20)

```
CrazyFuckingVideos, PublicFreakout, AbruptChaos, Unexpected,
IdiotsInCars, Whatcouldgowrong, WinStupidPrizes, therewasanattempt,
nonononoyes, yesyesyesyesno, nextfuckinglevel, SweatyPalms,
WhyWereTheyFilming, Holdmybeer, WatchPeopleDieInside, HumansBeingBros,
BetterEveryLoop, perfectlycutscreams, maybemaybemaybe, interestingasfuck
```

---

## 13. Key Selectors Summary for Playwright

| Action | Selector |
|---|---|
| Wait for app load | `page.waitForSelector('#app_root')` |
| Click scrape | `page.locator('#scrape_reddit_button').click()` |
| Wait for results | `page.waitForSelector('#results_wrapper')` |
| Wait for loading done | `page.waitForSelector('#loading_spinner_block', { state: 'hidden' })` |
| Filter by subreddit tab | `page.locator('#tab_filter_crazyfuckingvideos').click()` |
| Search clips | `page.locator('#search_clips_input').fill('keyword')` |
| Clear search | `page.getByText('CLEAR').click()` |
| Load more | `page.locator('#load_more_button').click()` |
| Play video | `page.locator('#play_overlay_0').click()` |
| Download video | `page.locator('#download_btn_0').click()` + `page.waitForEvent('download')` |
| Open Reddit post | `page.locator('#open_reddit_btn_0').click()` |
| Scroll to card | `page.locator('#clip_card_5').scrollIntoViewIfNeeded()` |
| Get card count | `page.locator('[id^="clip_card_"]').count()` |
