const EXT_SOURCE = 'reddit-scraper-extension'
const PAGE_SOURCE = 'reddit-dashboard'

function announce() {
  window.postMessage({ source: EXT_SOURCE, type: 'READY' }, window.location.origin)
}

const extensionAlive = () => Boolean(chrome.runtime?.id)

function reportOrphaned() {
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

window.addEventListener('message', (event) => {
  if (event.source !== window) return

  const message = event.data
  if (!message || message.source !== PAGE_SOURCE) return

  if (message.type === 'PING') {
    if (extensionAlive()) announce()
    return
  }

  if (message.type === 'SCRAPE' && message.company) {
    if (!extensionAlive()) {
      reportOrphaned()
      return
    }

    try {
      chrome.runtime.sendMessage({ type: 'START_SCRAPE', company: message.company })
    } catch (error) {
      console.warn('[bridge] could not reach the extension:', error.message)
      reportOrphaned()
    }
  }
})

if (extensionAlive()) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.job) return
    window.postMessage(
      { source: EXT_SOURCE, type: 'JOB', job: changes.job.newValue },
      window.location.origin,
    )
  })
}
