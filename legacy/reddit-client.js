// LEGACY — see legacy/config.js. Same role as background/reddit-client.js
// (the only fetcher against reddit.com, routed through the rate limiter),
// but simpler: no content-type/edge-block detection on failure responses,
// and no multi-host fallback helper — legacy/collectors.js builds every URL
// against old.reddit.com directly instead of calling a searchJson() here.
import { RATE_LIMIT_RETRIES, MAX_BACKOFF_MS } from './config.js'
import { setJob } from './job-store.js'
import { longSleep } from './http-util.js'
import { BudgetExhausted, RateLimited, isStopSignal } from './errors.js'
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

export async function redditJson(url, attempt = 0) {
  if (responseCache.has(url)) return responseCache.get(url)

  if (isLockedOut()) {
    const minutes = Math.ceil((getLockedOutUntil() - Date.now()) / 60_000)
    throw new RateLimited(
      `Reddit has rate-limited this browser session for about ${minutes} more ` +
        `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost — try again after that.`,
    )
  }

  if (!hasBudget()) throw new BudgetExhausted()

  if (attempt === 0) await beginRequest()

  const response = await fetch(url, { credentials: 'include' })
  noteRateHeaders(response)

  if (response.url.includes('/login')) {
    throw new Error('Reddit redirected to login — sign in to Reddit in this browser, then retry.')
  }

  if (response.status === 429 || response.status === 503) {
    if (attempt >= RATE_LIMIT_RETRIES) {
      throw new RateLimited(
        'Reddit is rate-limiting this browser session. Wait a few minutes and try again — ' +
          'nothing already collected was lost.',
      )
    }

    await recordRateLimitHit()
    const wait = retryAfterMs(response, attempt)

    if (wait > MAX_BACKOFF_MS) {
      await lockOut(wait)
      const minutes = Math.ceil(wait / 60_000)
      throw new RateLimited(
        `Reddit has rate-limited this browser session for about ${minutes} more ` +
          `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost — try again after that.`,
      )
    }

    console.warn(
      `[scraper] rate limited (${response.status}); waiting ${Math.round(wait / 1000)}s ` +
        `(attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`,
    )
    await setJob({
      step: `Reddit asked us to slow down — waiting ${Math.round(wait / 1000)}s…`,
    })
    await longSleep(wait)
    return redditJson(url, attempt + 1)
  }

  if (!response.ok) throw new Error(`Reddit responded with ${response.status}`)

  recordSuccess()
  const data = await response.json()
  responseCache.set(url, data)
  return data
}

export async function redditJsonSafe(url) {
  try {
    return await redditJson(url)
  } catch (error) {
    if (isStopSignal(error)) throw error
    console.warn('[scraper] optional fetch failed:', url, error.message)
    return null
  }
}
