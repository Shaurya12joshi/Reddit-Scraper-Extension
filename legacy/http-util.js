// LEGACY — see legacy/config.js. sleep/longSleep only (this older version
// has no phraseQuery — search terms were sent to Reddit unquoted).
import { KEEPALIVE_CHUNK_MS } from './config.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Chunked wait that touches chrome.storage.local between chunks so the
// service worker isn't killed mid-wait — see background/http-util.js for
// the fuller explanation, unchanged here.
export async function longSleep(ms) {
  let remaining = ms
  while (remaining > 0) {
    const chunk = Math.min(remaining, KEEPALIVE_CHUNK_MS)
    await sleep(chunk)
    remaining -= chunk
    if (remaining > 0) await chrome.storage.local.get('job')
  }
}
