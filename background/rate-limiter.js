// The throttling engine. Nothing else in the extension is allowed to fetch
// Reddit directly — reddit-client.js routes every request through here so
// the scraper stays under Reddit's rate limit and doesn't get the browser
// session temporarily blocked.
//
// It does two related jobs:
//  1. Self-throttles proactively: caps requests to `learnedLimit` per
//     rolling minute (sentAt window), and additionally watches Reddit's own
//     x-ratelimit-* response headers to slow down before getting refused.
//  2. Learns from refusals: when Reddit does refuse (429/503), it lowers
//     `learnedLimit` and remembers the count that got refused (`refusedAt`),
//     persisting that to chrome.storage.local (loadRateState/saveRateState)
//     so the *next* run starts already knowing roughly where the ceiling is,
//     instead of re-discovering it by getting refused again.
//
// Used by reddit-client.js (every fetch goes through beginRequest / pace /
// recordSuccess / recordRateLimitHit) and by run-scrape.js / run-field-scan.js
// (resetForRun at the start of a run, easeLimitUp on a clean finish).
import {
  DELAY_MS,
  MAX_DELAY_MS,
  MIN_RETRY_DELAY_MS,
  JITTER_RATIO,
  WINDOW_MS,
  DEFAULT_REQUESTS_PER_WINDOW,
  MIN_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW,
  REFUSAL_MEMORY_MS,
  RATE_WATCH_FLOOR,
  RATE_FLOOR,
  RUN_READ_BUDGET,
  RATE_STATE_KEY,
  RATE_STATE_VERSION,
  LEARN_DEBOUNCE_MS,
  RAMP_EVERY_N_SUCCESSES,
} from './config.js'
import { sleep, longSleep } from './http-util.js'
import { setJob } from './job-store.js'

// Learned Reddit request-per-minute ceiling, adjusted up/down as runs hit or avoid 429s.
let learnedLimit = DEFAULT_REQUESTS_PER_WINDOW
let refusedAt = Infinity
let refusedAtRecordedAt = 0
let lastLearnedAt = 0

// Per-request pacing delay, widened on 429/503 and eased back on success.
let currentDelay = DELAY_MS

// Reddit's own rate-limit response headers.
let rateRemaining = Infinity
let rateUsed = null
let rateResetAt = 0

// Hard lockout window after repeated rate-limit failures.
let lockedOutUntil = 0

// Sliding window of request timestamps used to self-throttle under learnedLimit.
let sentAt = []

let requestLockChain = Promise.resolve()
let readsUsed = 0
let successStreak = 0

// Called once at the top of runScrape/runFieldScan to zero out everything
// that's scoped to a single run (the learned limit and lockout state are
// deliberately NOT reset here — those persist across runs).
export function resetForRun() {
  readsUsed = 0
  successStreak = 0
  currentDelay = DELAY_MS
  rateRemaining = Infinity
  rateResetAt = 0
}

export const pace = () => sleep(currentDelay)
export const hasBudget = () => readsUsed < RUN_READ_BUDGET
export const getReadsUsed = () => readsUsed
export const getLockedOutUntil = () => lockedOutUntil
export const isLockedOut = () => Date.now() < lockedOutUntil

// Widens the per-request delay after a 429/503 (multiplicative backoff).
function slowDown() {
  currentDelay = Math.min(MAX_DELAY_MS, Math.round(currentDelay * 1.8))
}

// Narrows the delay back toward the baseline after a clean response
// (multiplicative ease-back, so it never overshoots below DELAY_MS).
function easeBackDelay() {
  if (currentDelay > DELAY_MS) {
    currentDelay = Math.max(DELAY_MS, Math.round(currentDelay * 0.92))
  }
}

// Every RAMP_EVERY_N_SUCCESSES clean requests in a row, try nudging the
// learned per-minute ceiling back up — lets a run recover speed within
// itself instead of waiting for the next run's easeLimitUp() call.
function maybeRampWithinRun() {
  successStreak += 1
  if (successStreak % RAMP_EVERY_N_SUCCESSES !== 0) return
  easeLimitUp()
}

// Called by reddit-client.js after any successful (2xx, JSON) response.
export function recordSuccess() {
  easeBackDelay()
  maybeRampWithinRun()
}

// Reads Reddit's rate-limit headers off a response so awaitRateWindow() can
// react to them even before we've sent enough requests to fill our own
// self-throttle window.
export function noteRateHeaders(response) {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  if (Number.isFinite(remaining)) rateRemaining = remaining

  const used = Number(response.headers.get('x-ratelimit-used'))
  if (Number.isFinite(used)) rateUsed = used

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset >= 0) rateResetAt = Date.now() + reset * 1000
}

// Restores the learned limit, refusal memory, and any active lockout from
// chrome.storage.local. Called at the start of every run, before the first
// request goes out, so a fresh run benefits from what previous runs learned.
export async function loadRateState() {
  const stored = (await chrome.storage.local.get(RATE_STATE_KEY))[RATE_STATE_KEY]
  if (!stored) return
  lockedOutUntil = stored.lockedOutUntil || 0

  const now = Date.now()
  sentAt = (stored.sentAt || []).filter((at) => now - at < WINDOW_MS)

  if (stored.version !== RATE_STATE_VERSION) {
    console.warn('[scraper] discarding rate figures written by an older version; relearning from the default')
    learnedLimit = DEFAULT_REQUESTS_PER_WINDOW
    refusedAt = Infinity
    refusedAtRecordedAt = 0
    await saveRateState()
    return
  }

  if (Number.isFinite(stored.learnedLimit)) {
    learnedLimit = Math.max(
      MIN_REQUESTS_PER_WINDOW,
      Math.min(MAX_REQUESTS_PER_WINDOW, stored.learnedLimit),
    )
  }
  if (Number.isFinite(stored.refusedAt) && stored.refusedAt >= MIN_REQUESTS_PER_WINDOW) {
    const recordedAt = Number(stored.refusedAtRecordedAt) || 0
    if (recordedAt && now - recordedAt > REFUSAL_MEMORY_MS) {
      console.warn('[scraper] last refusal is over 24h old, forgetting it and re-testing the ceiling')
      refusedAt = Infinity
      refusedAtRecordedAt = 0
    } else {
      refusedAt = stored.refusedAt
      refusedAtRecordedAt = recordedAt
    }
  }
}

export async function saveRateState() {
  await chrome.storage.local.set({
    [RATE_STATE_KEY]: {
      version: RATE_STATE_VERSION,
      lockedOutUntil,
      sentAt,
      learnedLimit,
      refusedAt: Number.isFinite(refusedAt) ? refusedAt : null,
      refusedAtRecordedAt,
    },
  })
}

// After a 429/503, works out how many requests actually went through this
// minute before the refusal and, if that's a meaningful sample (not just an
// existing lockout still biting), lowers learnedLimit below it so future
// runs don't hit the same wall. Debounced so a burst of retries in the same
// backoff doesn't ratchet the limit down repeatedly for one refusal.
function learnFromRefusal() {
  const now = Date.now()
  if (now - lastLearnedAt < LEARN_DEBOUNCE_MS) return
  lastLearnedAt = now

  const spent = sentAt.filter((at) => Date.now() - at < WINDOW_MS).length
  const meaningful = Math.max(MIN_REQUESTS_PER_WINDOW, Math.ceil(learnedLimit * 0.6))

  if (spent < meaningful) {
    console.warn(
      `[scraper] refused after only ${spent} request(s) this minute, a lockout still in ` +
        `force, not a new limit. Cap stays at ${learnedLimit}/min.`,
    )
    return
  }

  refusedAt = Math.min(refusedAt, spent)
  refusedAtRecordedAt = Date.now()
  const next = Math.floor(spent * 0.6)
  learnedLimit = Math.max(MIN_REQUESTS_PER_WINDOW, Math.min(learnedLimit - 1, next))
  console.warn(`[scraper] rate limit learned: ${spent} in the last minute was too many; now capping at ${learnedLimit}/min`)
}

// Nudges the learned limit back up, capped just under the last known
// refusal point (or MAX_REQUESTS_PER_WINDOW if we've never been refused).
// Called both mid-run (maybeRampWithinRun) and at the end of a run that
// finished cleanly (run-scrape.js / run-field-scan.js).
export function easeLimitUp() {
  const ceiling = Math.max(
    MIN_REQUESTS_PER_WINDOW,
    Math.min(
      MAX_REQUESTS_PER_WINDOW,
      refusedAt === Infinity ? MAX_REQUESTS_PER_WINDOW : refusedAt - 2,
    ),
  )
  if (learnedLimit >= ceiling) return
  learnedLimit = Math.min(ceiling, learnedLimit + 4)
}

// Called by reddit-client.js right after a 429/503 comes back, before it
// decides how long to wait.
export async function recordRateLimitHit() {
  slowDown()
  learnFromRefusal()
  await saveRateState()
}

// Reddit is refusing hard enough (retry wait past MAX_BACKOFF_MS) that
// reddit-client.js gives up retrying and locks the whole extension out for
// `ms` — every request during that window fails fast with a RateLimited
// error instead of hitting Reddit again.
export async function lockOut(ms) {
  lockedOutUntil = Date.now() + ms
  await saveRateState()
}

// How long (ms) the next request must wait before it's allowed to send,
// based purely on the self-throttle window (learnedLimit per WINDOW_MS).
function windowWait() {
  const now = Date.now()
  sentAt = sentAt.filter((at) => now - at < WINDOW_MS)
  if (sentAt.length < learnedLimit) return 0
  return WINDOW_MS - (now - sentAt[0])
}

// Serializes calls to awaitRateWindow() so concurrent requests (the deep
// phase in run-scrape.js reads several threads in parallel) don't all check
// the window at once and pile past learnedLimit together.
function withRequestLock(fn) {
  const run = requestLockChain.then(fn, fn)
  requestLockChain = run.then(
    () => {},
    () => {},
  )
  return run
}

// The actual wait-your-turn logic: checks the self-throttle window first,
// then Reddit's live rate-limit headers (hard-wait if remaining is critically
// low, soft pre-emptive slowdown if it's merely getting low), sleeps if
// needed, then records this request's timestamp.
async function awaitRateWindow() {
  let wait = windowWait()

  if (!wait && rateRemaining <= RATE_FLOOR) {
    const headerWait = rateResetAt - Date.now()
    if (headerWait > 0) wait = headerWait
    else rateRemaining = Infinity
  } else if (!wait && rateRemaining <= RATE_WATCH_FLOOR) {
    const closeness = (RATE_WATCH_FLOOR - rateRemaining) / (RATE_WATCH_FLOOR - RATE_FLOOR)
    wait = Math.round(closeness * 4000)
  }

  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000)
    console.warn(
      `[scraper] pausing ${seconds}s (window ${sentAt.length}/${learnedLimit}, ` +
        `remaining=${rateRemaining}, used=${rateUsed})`,
    )
    await setJob({ step: `Staying inside Reddit's limit, pausing ${seconds}s…` })
    await longSleep(wait)
    if (rateRemaining <= RATE_FLOOR) rateRemaining = Infinity
    windowWait()
  }

  sentAt.push(Date.now())
  await saveRateState()
}

// Call before dispatching a fresh (non-retry) request: waits its turn in the
// self-throttle window, then counts it against this run's read budget.
export async function beginRequest() {
  await withRequestLock(awaitRateWindow)
  readsUsed++
}

// Randomizes a wait by +/- JITTER_RATIO so parallel deep-phase workers
// retrying after the same 429 don't all wake up and retry in lockstep.
function withJitter(ms) {
  return Math.round(ms + ms * JITTER_RATIO * (Math.random() * 2 - 1))
}

// Works out how long to wait before retrying a 429/503: prefers Reddit's
// Retry-After header, falls back to its x-ratelimit-reset header, and
// finally to plain exponential backoff if neither header is present.
export function retryAfterMs(response, attempt) {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(MIN_RETRY_DELAY_MS, withJitter(seconds * 1000))
    }
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(MIN_RETRY_DELAY_MS, withJitter(at - Date.now()))
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(MIN_RETRY_DELAY_MS, withJitter(reset * 1000))
  }

  return Math.max(MIN_RETRY_DELAY_MS, withJitter(2000 * 2 ** attempt))
}
