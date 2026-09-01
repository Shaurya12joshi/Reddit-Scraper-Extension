// LEGACY — see legacy/config.js. Same role as background/rate-limiter.js
// (self-throttle window + learned per-minute ceiling, used exclusively by
// legacy/reddit-client.js), but simpler: no request lock (see the note on
// beginRequest below), no rateUsed header tracking, no within-run ramp-up,
// no jitter on retry waits, and easeLimitUp only nudges the limit by +2.
import {
  DELAY_MS,
  MAX_DELAY_MS,
  WINDOW_MS,
  DEFAULT_REQUESTS_PER_WINDOW,
  MIN_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW,
  RATE_FLOOR,
  RUN_READ_BUDGET,
  RATE_STATE_KEY,
  RATE_STATE_VERSION,
} from './config.js'
import { sleep, longSleep } from './http-util.js'
import { setJob } from './job-store.js'

let learnedLimit = DEFAULT_REQUESTS_PER_WINDOW
let refusedAt = Infinity

let currentDelay = DELAY_MS

let rateRemaining = Infinity
let rateResetAt = 0

let lockedOutUntil = 0

let sentAt = []
let readsUsed = 0

export function resetForRun() {
  readsUsed = 0
  currentDelay = DELAY_MS
  rateRemaining = Infinity
  rateResetAt = 0
}

export const pace = () => sleep(currentDelay)
export const hasBudget = () => readsUsed < RUN_READ_BUDGET
export const getReadsUsed = () => readsUsed
export const getLockedOutUntil = () => lockedOutUntil
export const isLockedOut = () => Date.now() < lockedOutUntil

function slowDown() {
  currentDelay = Math.min(MAX_DELAY_MS, Math.round(currentDelay * 1.8))
}

export function recordSuccess() {
  if (currentDelay > DELAY_MS) {
    currentDelay = Math.max(DELAY_MS, Math.round(currentDelay * 0.92))
  }
}

export function noteRateHeaders(response) {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  if (Number.isFinite(remaining)) rateRemaining = remaining

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset >= 0) rateResetAt = Date.now() + reset * 1000
}

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
    refusedAt = stored.refusedAt
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
    },
  })
}

function learnFromRefusal() {
  const spent = sentAt.filter((at) => Date.now() - at < WINDOW_MS).length
  const meaningful = Math.max(MIN_REQUESTS_PER_WINDOW, Math.ceil(learnedLimit * 0.6))

  if (spent < meaningful) {
    console.warn(
      `[scraper] refused after only ${spent} request(s) this minute — a lockout still in ` +
        `force, not a new limit. Cap stays at ${learnedLimit}/min.`,
    )
    return
  }

  refusedAt = Math.min(refusedAt, spent)
  const next = Math.floor(spent * 0.6)
  learnedLimit = Math.max(MIN_REQUESTS_PER_WINDOW, Math.min(learnedLimit - 1, next))
  console.warn(`[scraper] rate limit learned: ${spent} in the last minute was too many; now capping at ${learnedLimit}/min`)
}

export function easeLimitUp() {
  const ceiling = Math.max(
    MIN_REQUESTS_PER_WINDOW,
    Math.min(
      MAX_REQUESTS_PER_WINDOW,
      refusedAt === Infinity ? MAX_REQUESTS_PER_WINDOW : refusedAt - 2,
    ),
  )
  if (learnedLimit >= ceiling) return
  learnedLimit = Math.min(ceiling, learnedLimit + 2)
}

export async function recordRateLimitHit() {
  slowDown()
  learnFromRefusal()
  await saveRateState()
}

export async function lockOut(ms) {
  lockedOutUntil = Date.now() + ms
  await saveRateState()
}

function windowWait() {
  const now = Date.now()
  sentAt = sentAt.filter((at) => now - at < WINDOW_MS)
  if (sentAt.length < learnedLimit) return 0
  return WINDOW_MS - (now - sentAt[0])
}

async function awaitRateWindow() {
  let wait = windowWait()

  if (!wait && rateRemaining <= RATE_FLOOR) {
    const headerWait = rateResetAt - Date.now()
    if (headerWait > 0) wait = headerWait
    else rateRemaining = Infinity
  }

  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000)
    console.warn(`[scraper] window full (${sentAt.length}/${learnedLimit}); pausing ${seconds}s`)
    await setJob({ step: `Staying inside Reddit's limit — pausing ${seconds}s…` })
    await longSleep(wait)
    rateRemaining = Infinity
    windowWait()
  }

  sentAt.push(Date.now())
  await saveRateState()
}

// Note: unlike background/rate-limiter.js, this older version has no request
// lock — concurrent callers could race on awaitRateWindow. It never mattered
// because this version's runScrape only ever reads threads sequentially.
export async function beginRequest() {
  await awaitRateWindow()
  readsUsed++
}

export function retryAfterMs(response, attempt) {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(at - Date.now(), 0)
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return reset * 1000

  return 2000 * 2 ** attempt
}
