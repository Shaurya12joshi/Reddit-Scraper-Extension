// Central place for every tunable number the scraper uses: pacing, retry
// budgets, cache lifetimes, and how much of each subreddit/thread we sample.
// Every other file in background/ imports its constants from here instead of
// hardcoding them, so tuning the scraper means editing this one file.

// Where collected posts get shipped, unless the user's popup (popup.js) or
// the dashboard page (via bridge.js) says otherwise — see backend-url.js.
export const DEFAULT_BACKEND_URL = 'https://reddit-scrapper-ncxc.onrender.com'

// Reddit search is tried against old.reddit.com first; if that host comes
// back with zero posts, reddit-client.js falls back to www.reddit.com.
export const REDDIT_HOSTS = ['https://old.reddit.com', 'https://www.reddit.com']

// Every collect() call (collectors.js) is either a cheap SHALLOW pass (one
// page, no extra fetches) or a slower DEEP pass (multiple pages, subreddit
// post-rate sampling, full thread + comments).
export const DEPTH = { SHALLOW: 'shallow', DEEP: 'deep' }

// --- Discovery shape: how wide/deep run-scrape.js casts its net ---
export const SEED_PAGES = 1 // pages fetched for the first "does this company exist on Reddit" search
export const BASE_SEARCH_PAGES = 3 // extra relevance-sorted pages read after the seed search
export const TOPIC_COMMUNITY_QUERIES = 1 // how many of the backend's suggested "facets" get a communities search
export const MAX_COMMUNITIES = 10 // size of the subreddit shortlist that gets measured/deep-dived
export const MIN_EXPANSION_SLOTS = 2 // shortlist slots reserved for subreddits found via topic/context search, not just direct company hits
export const PACE_SAMPLES = 8 // first N subreddits get a DEEP profile fetch (post-rate sample); rest get SHALLOW
export const COMMUNITY_LIMIT = 100 // max posts pulled from a single subreddit search
export const SUB_RATE_SAMPLE = 100 // posts sampled from r/<sub>/new to estimate that subreddit's posts-per-day
export const COMMENTS_PER_THREAD = 40 // comments read per deep-dived thread
export const MAX_RULE_FETCHES = 2 // subreddits whose rules get fetched (used in the deep phase)
export const FIELD_QUERIES = 8 // backend-suggested field/industry queries run per scan
export const DEEP_THREAD_LIMIT = 30 // top-ranked threads the backend picks for the deep (comment-reading) phase
export const DEEP_CONCURRENCY = 3 // how many threads run-scrape.js reads in parallel during the deep phase

// --- Pacing: the fixed delay between requests, widened on 429/503 ---
export const DELAY_MS = 1200
export const MAX_DELAY_MS = 8000
export const MIN_RETRY_DELAY_MS = 1500
export const RATE_LIMIT_RETRIES = 4 // retries per request before giving up and surfacing a RateLimited error
export const MAX_BACKOFF_MS = 60_000 // beyond this, stop retrying and lock the whole run out instead (see rate-limiter.js lockOut)
export const JITTER_RATIO = 0.2 // +/- randomness applied to retry waits so parallel deep-phase workers don't retry in lockstep

// --- Self-throttling: how many requests we allow ourselves per rolling minute ---
export const WINDOW_MS = 60_000
export const DEFAULT_REQUESTS_PER_WINDOW = 30 // starting guess before any run has taught us Reddit's real ceiling
export const MIN_REQUESTS_PER_WINDOW = 6
export const MAX_REQUESTS_PER_WINDOW = 60
export const REFUSAL_MEMORY_MS = 24 * 60 * 60 * 1000 // a learned "too many requests" ceiling older than this is forgotten and re-tested

// Reddit's own x-ratelimit-remaining header: below RATE_WATCH_FLOOR we start
// slowing down pre-emptively; at/below RATE_FLOOR we wait out the header's reset.
export const RATE_WATCH_FLOOR = 15
export const RATE_FLOOR = 5

// --- Per-run ceilings, independent of rate limiting ---
export const RUN_READ_BUDGET = 120 // max Reddit requests a single runScrape/runFieldScan call will make
export const MAX_POSTS_PER_COMPANY = 600 // stop merging newly found posts into byId once this many are held in memory

// Long waits (rate-limit backoffs, self-throttle pauses) are slept in chunks
// this long, touching chrome.storage between chunks so Chrome's service
// worker lifecycle doesn't kill the worker mid-wait (see http-util.js longSleep).
export const KEEPALIVE_CHUNK_MS = 20_000

// Subreddit profile/rules lookups are cached in chrome.storage.local
// (cache-store.js) and reused across runs until this old.
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PROFILE_CACHE_KEY = 'subProfileCache'
export const RULES_CACHE_KEY = 'subRulesCache'

// Key + schema version for the learned rate-limit state persisted between
// runs (rate-limiter.js loadRateState/saveRateState). Bumping the version
// discards stale state from an older build instead of misreading it.
export const RATE_STATE_KEY = 'rateState'
export const RATE_STATE_VERSION = 3

export const LEARN_DEBOUNCE_MS = 3000 // don't relearn the rate ceiling more than once per this many ms
export const RAMP_EVERY_N_SUCCESSES = 3 // ease the learned limit back up after this many consecutive clean requests
