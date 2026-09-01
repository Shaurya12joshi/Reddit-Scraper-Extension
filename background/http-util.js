// Small, stateless helpers with no dependency on the rest of the scraper —
// used by rate-limiter.js (pacing/backoff waits) and by run-scrape.js /
// run-field-scan.js (query formatting) wherever they need them.
import { KEEPALIVE_CHUNK_MS } from './config.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Like sleep(), but for waits that can run tens of seconds (rate-limit
// backoffs, self-throttle pauses). Chrome can kill an idle service worker
// mid-wait, so this breaks the sleep into KEEPALIVE_CHUNK_MS pieces and
// touches chrome.storage.local between them — that access keeps the worker
// alive for the duration of the wait.
export async function longSleep(ms) {
  let remaining = ms
  while (remaining > 0) {
    const chunk = Math.min(remaining, KEEPALIVE_CHUNK_MS)
    await sleep(chunk)
    remaining -= chunk
    if (remaining > 0) await chrome.storage.local.get('job')
  }
}

// Reddit's search treats multi-word queries as an OR of terms unless
// quoted. This wraps any term containing whitespace in quotes so
// "acme corp" is searched as a phrase, not as posts mentioning "acme" OR
// "corp". Used by run-scrape.js / run-field-scan.js before every search.
export function phraseQuery(value) {
  const term = String(value || '').trim()
  if (!term || term.startsWith('"')) return term
  return /\s/.test(term) ? `"${term}"` : term
}
