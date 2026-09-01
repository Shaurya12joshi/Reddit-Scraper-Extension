// Content script injected into the Mercuric dashboard page (per
// manifest.json's content_scripts entry, matches the dashboard's deployed
// URL plus localhost/127.0.0.1 for local dev). Runs at document_start,
// directly on the page — it's the only piece of the extension the
// dashboard's own JavaScript can talk to (a service worker can't hear
// window.postMessage, and a web page can't call chrome.runtime directly).
//
// It's a two-way relay:
//   page -> extension: listens for the dashboard's SCRAPE/PING
//     window.postMessage calls and forwards them to the background service
//     worker (background/index.js) as chrome.runtime messages.
//   extension -> page: watches chrome.storage's 'job' key (written by
//     background/job-store.js throughout a run) and posts each update back
//     to the page as a window.postMessage, so the dashboard's own UI can
//     show live progress without polling.
const EXT_SOURCE = 'reddit-scraper-extension'
const PAGE_SOURCE = 'reddit-dashboard'

// Tells the page this content script is alive and can relay messages.
function announce() {
  window.postMessage({ source: EXT_SOURCE, type: 'READY' }, window.location.origin)
}

// chrome.runtime.id disappears when the extension is reloaded/updated while
// this content script is still injected in an old page — checking it lets
// us tell the dashboard "the extension side is gone, reload the page"
// instead of silently failing every message.
const extensionAlive = () => Boolean(chrome.runtime?.id)

function announceOrphaned() {
  window.postMessage({ source: EXT_SOURCE, type: 'ORPHANED' }, window.location.origin)
}

function reportOrphaned() {
  announceOrphaned()
  window.postMessage(
    {
      source: EXT_SOURCE,
      type: 'JOB',
      job: {
        status: 'error',
        step: 'The collector extension was reloaded. Refresh this page to reconnect it.',
        updatedAt: Date.now(),
      },
    },
    window.location.origin,
  )
}

announce()

// Handles messages the dashboard page posts to itself (window.postMessage,
// origin-restricted). PING lets the page re-check the extension is still
// alive; SCRAPE is the actual "start a run" request, relayed to
// background/index.js as a START_SCRAPE chrome.runtime message.
window.addEventListener('message', (event) => {
  if (event.source !== window) return

  const message = event.data
  if (!message || message.source !== PAGE_SOURCE) return

  if (message.type === 'PING') {
    if (extensionAlive()) announce()
    else announceOrphaned()
    return
  }

  if (message.type === 'SCRAPE' && message.company) {
    if (!extensionAlive()) {
      reportOrphaned()
      return
    }

    try {
      chrome.runtime.sendMessage({
        type: 'START_SCRAPE',
        company: message.company,
        keywords: message.keywords || '',
        fieldOnly: Boolean(message.fieldOnly),
        apiBase: message.apiBase || window.location.origin,
      })
    } catch (error) {
      console.warn('[bridge] could not reach the extension:', error.message)
      reportOrphaned()
    }
  }
})

// Relays every job-status update from background/job-store.js's setJob()
// straight to the page, live, for as long as the extension is reachable.
if (extensionAlive()) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.job) return
    window.postMessage(
      { source: EXT_SOURCE, type: 'JOB', job: changes.job.newValue },
      window.location.origin,
    )
  })
}
