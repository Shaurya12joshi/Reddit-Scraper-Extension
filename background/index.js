// The actual manifest.json entry point (background.service_worker,
// "type": "module") — this is the file Chrome loads when the extension's
// service worker starts. Its only job is wiring: listen for the
// START_SCRAPE message and hand off to the right run function.
//
// The message itself comes from bridge.js — a content script injected into
// the Mercuric dashboard page, which relays the page's own window.postMessage
// SCRAPE request into a chrome.runtime message this worker can hear (a
// service worker can't listen to window.postMessage directly).
import { usePageBackend } from './backend-url.js'
import { setJob } from './job-store.js'
import { runScrape } from './run-scrape.js'
import { runFieldScan } from './run-field-scan.js'

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'START_SCRAPE') return

  // The dashboard page tells us its own origin so results get posted back
  // to wherever the user is actually running the dashboard from (e.g. a
  // local dev server), overriding the default/stored backend URL for this run.
  usePageBackend(message.apiBase)

  const job = message.fieldOnly
    ? runFieldScan(message.keywords)
    : runScrape(message.company, message.keywords)

  // Both run functions handle their own errors internally and update the
  // job status accordingly — this catch is only a last-resort net for a
  // truly unexpected throw that slipped past that handling.
  job.catch(async (error) => {
    console.error('[scraper] run failed outright:', error)
    await setJob({ status: 'error', step: error?.message || 'The collector stopped unexpectedly.' })
  })
})
