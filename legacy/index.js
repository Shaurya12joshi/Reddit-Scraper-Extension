// Old background service worker — superseded by background/index.js.
// Kept only for reference; not wired into manifest.json, does not run.
import { setJob } from './job-store.js'
import { runScrape } from './run-scrape.js'

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'START_SCRAPE') return

  runScrape(message.company).catch(async (error) => {
    console.error('[scraper] run failed outright:', error)
    await setJob({ status: 'error', step: error?.message || 'The collector stopped unexpectedly.' })
  })
})
