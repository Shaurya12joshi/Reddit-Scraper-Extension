// The only place in the extension that actually calls fetch() against
// reddit.com. Every request goes through rate-limiter.js first (lockout
// check, budget check, self-throttle wait), retries automatically on
// 429/503, and is cached per-run by URL so collectors.js never re-fetches
// the same page twice within one run (see clearResponseCache, called at the
// start of every runScrape/runFieldScan).
//
// collectors.js is the only consumer of redditJson/redditJsonSafe/searchJson
// — it decides *what* to fetch, this file decides *how* to fetch it safely.
import { REDDIT_HOSTS, RATE_LIMIT_RETRIES, MAX_BACKOFF_MS } from './config.js'
import { setJob } from './job-store.js'
import { longSleep } from './http-util.js'
import { BudgetExhausted, RateLimited, isStopSignal } from './errors.js'
import { postsFrom } from './mappers.js'
import {
  isLockedOut,
  getLockedOutUntil,
  hasBudget,
  beginRequest,
  noteRateHeaders,
  recordRateLimitHit,
  recordSuccess,
  retryAfterMs,
  lockOut,
} from './rate-limiter.js'

const responseCache = new Map()

export const clearResponseCache = () => responseCache.clear()

// Fetches one Reddit URL and returns parsed JSON, throwing on failure.
// `attempt` counts retries after a 429/503 — only the first attempt (0) is
// charged against the rate limiter's window/budget, since retries are the
// same logical request, not new ones.
export async function redditJson(url, attempt = 0) {
  if (responseCache.has(url)) return responseCache.get(url)

  if (isLockedOut()) {
    const minutes = Math.ceil((getLockedOutUntil() - Date.now()) / 60_000)
    throw new RateLimited(
      `Reddit has rate-limited this browser session for about ${minutes} more ` +
        `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost, try again after that.`,
    )
  }

  if (!hasBudget()) throw new BudgetExhausted()

  if (attempt === 0) await beginRequest()

  const response = await fetch(url, { credentials: 'include' })
  noteRateHeaders(response)

  if (response.url.includes('/login')) {
    throw new Error('Reddit redirected to login. Sign in to Reddit in this browser, then retry.')
  }

  if (response.status === 429 || response.status === 503) {
    if (attempt >= RATE_LIMIT_RETRIES) {
      throw new RateLimited(
        'Reddit is rate-limiting this browser session. Wait a few minutes and try again, ' +
          'nothing already collected was lost.',
      )
    }

    await recordRateLimitHit()
    const wait = retryAfterMs(response, attempt)

    // Too long a wait isn't worth retrying inline — lock the whole run out
    // instead so every other in-flight request fails fast too.
    if (wait > MAX_BACKOFF_MS) {
      await lockOut(wait)
      const minutes = Math.ceil(wait / 60_000)
      throw new RateLimited(
        `Reddit has rate-limited this browser session for about ${minutes} more ` +
          `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost, try again after that.`,
      )
    }

    console.warn(
      `[scraper] rate limited (${response.status}); waiting ${Math.round(wait / 1000)}s ` +
        `(attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`,
    )
    await setJob({
      step: `Reddit asked us to slow down, waiting ${Math.round(wait / 1000)}s…`,
    })
    await longSleep(wait)
    return redditJson(url, attempt + 1)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!response.ok || !contentType.includes('json')) {
    // A non-JSON 403/503 usually means an edge/WAF block rather than the
    // normal JSON rate-limit response — worth telling the user apart from a
    // plain rate limit, since the fix (re-authenticate) is different.
    if (!contentType.includes('json') && (response.status === 403 || response.status === 503)) {
      console.warn(`[scraper] non-JSON response at ${response.status}, likely an edge block, not a rate limit`)
      throw new Error(
        'Reddit blocked this request at the edge (not a rate limit). This browser session may need ' +
          're-authenticating on reddit.com.',
      )
    }
    if (!response.ok) throw new Error(`Reddit responded with ${response.status}`)
  }

  recordSuccess()
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('Reddit returned a response that was not valid JSON.')
  }
  responseCache.set(url, data)
  return data
}

// Same as redditJson, but treats every failure as non-fatal for the current
// step: a BudgetExhausted/RateLimited still propagates up (the run needs to
// stop), but anything else is swallowed and reported as "this optional
// fetch didn't work, move on" — used for profile/rules/community lookups
// that shouldn't abort a whole run if one of them fails.
export async function redditJsonSafe(url) {
  try {
    return await redditJson(url)
  } catch (error) {
    if (isStopSignal(error)) throw error
    console.warn('[scraper] optional fetch failed:', url, error.message)
    return null
  }
}

// Tries old.reddit.com first, falls back to www.reddit.com if it comes back empty.
export async function searchJson(path, { required = false } = {}) {
  let firstError = null

  for (const host of REDDIT_HOSTS) {
    try {
      const data = await redditJson(`${host}${path}`)
      if (postsFrom(data).length || host === REDDIT_HOSTS[REDDIT_HOSTS.length - 1]) return data
    } catch (error) {
      if (isStopSignal(error)) throw error
      firstError = firstError || error
      console.warn(`[scraper] ${host} failed:`, error.message)
    }
  }

  if (required && firstError) throw firstError
  return null
}
