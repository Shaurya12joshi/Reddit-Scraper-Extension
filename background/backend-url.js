// Works out which Mercuric backend server the extension should talk to, and
// keeps that decision live as things change. backend-api.js calls
// getBackendUrl() before every request. Three sources feed it, highest
// priority first:
//   1. storedBackendUrl — the user typed one into the popup (popup.js saves
//      it to chrome.storage.local under 'backendUrl').
//   2. pageBackendUrl — the dashboard page itself announced its own origin
//      when it sent a SCRAPE message (bridge.js forwards it as apiBase,
//      background/index.js passes it to usePageBackend()).
//   3. DEFAULT_BACKEND_URL — the hosted fallback (config.js).
import { DEFAULT_BACKEND_URL } from './config.js'

// Trims trailing slashes and rejects anything that isn't a well-formed
// http(s) URL, so a stray typo in the popup can't silently break every
// backend call later.
function normalise(value) {
  const url = String(value || '').trim().replace(/\/$/, '')
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

let backendUrl = DEFAULT_BACKEND_URL
let pageBackendUrl = null
let storedBackendUrl = null

function resolveBackendUrl() {
  backendUrl = storedBackendUrl || pageBackendUrl || DEFAULT_BACKEND_URL
  return backendUrl
}

export const getBackendUrl = () => backendUrl

// Called once at the start of every run (run-scrape.js / run-field-scan.js)
// to pick up whatever the user has saved in the popup since the worker last
// woke up.
export async function loadBackendUrl() {
  storedBackendUrl = normalise((await chrome.storage.local.get('backendUrl')).backendUrl)
  return resolveBackendUrl()
}

// Called from background/index.js with the apiBase the dashboard page sent
// along with its SCRAPE message — lets a locally-run dashboard (e.g.
// localhost:5173) be scraped for without the user having to type anything.
export function usePageBackend(value) {
  const url = normalise(value)
  if (!url) return
  pageBackendUrl = url
  resolveBackendUrl()
}

// Keeps storedBackendUrl in sync if the user edits the popup's backend
// field while a run is already in flight.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.backendUrl) {
    storedBackendUrl = normalise(changes.backendUrl.newValue)
    resolveBackendUrl()
  }
})
