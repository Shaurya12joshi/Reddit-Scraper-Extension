// The single channel the background worker uses to report progress. Every
// step of a run (run-scrape.js, run-field-scan.js, reddit-client.js while
// waiting out a rate limit) calls setJob() with a partial update; the merged
// result is written to chrome.storage.local under the 'job' key.
//
// Two listeners pick this up automatically via chrome.storage.onChanged:
// popup.js (renders it in the extension popup) and bridge.js (relays it into
// the dashboard web page as a postMessage so the page's own UI can show it).
export async function setJob(patch) {
  const { job } = await chrome.storage.local.get('job')
  await chrome.storage.local.set({
    job: { ...(job || {}), ...patch, updatedAt: Date.now() },
  })
}
