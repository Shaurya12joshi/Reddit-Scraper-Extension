// LEGACY — dead code, not referenced by manifest.json or anything else in
// the repo. This is the older single-file background.cookie-session.js
// split into modules for readability, kept only as reference. See
// background/config.js for the constants actually in use.
//
// Same role as background/config.js (every tunable number for this older
// scraper), but reflects an earlier, simpler design: no field-scan phase,
// no MAX_POSTS_PER_COMPANY cap, no profile/rules caching, sequential (not
// parallel) thread reads.
export const BACKEND_URL = 'http://localhost:3001'

export const DEPTH = { SHALLOW: 'shallow', DEEP: 'deep' }

export const SEED_PAGES = 2
export const ROUND_ONE_QUERIES = 4
export const ROUND_TWO_QUERIES = 4
export const TOPIC_COMMUNITY_QUERIES = 3
export const ALIAS_QUERIES = 2
export const MAX_COMMUNITIES = 10
export const MIN_EXPANSION_SLOTS = 3
export const PACE_SAMPLES = 8
export const COMMUNITY_LIMIT = 100
export const SUB_RATE_SAMPLE = 100
export const COMMENTS_PER_THREAD = 40
export const MAX_RULE_FETCHES = 4

export const DELAY_MS = 1200
export const MAX_DELAY_MS = 8000
export const RATE_LIMIT_RETRIES = 4
export const MAX_BACKOFF_MS = 60_000

export const WINDOW_MS = 60_000

export const DEFAULT_REQUESTS_PER_WINDOW = 20
export const MIN_REQUESTS_PER_WINDOW = 6
export const MAX_REQUESTS_PER_WINDOW = 60

export const RATE_FLOOR = 5

export const RUN_READ_BUDGET = 110

export const KEEPALIVE_CHUNK_MS = 20_000

export const RATE_STATE_KEY = 'rateState'
export const RATE_STATE_VERSION = 2
