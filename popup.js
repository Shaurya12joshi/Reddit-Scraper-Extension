// Script for the extension's toolbar popup (popup.html, loaded per
// manifest.json's action.default_popup). Runs in its own popup context, not
// on any web page — it only talks to the rest of the extension through
// chrome.storage.local, the same channel background/job-store.js writes to
// and bridge.js relays to the dashboard page.
//
// Two things live here:
//   - a read-only view of the current/last run's status (job.step/status),
//     kept live via chrome.storage.onChanged — the same data bridge.js
//     shows inside the dashboard page itself.
//   - the backend URL override: what the user types here is saved to
//     chrome.storage.local under 'backendUrl', which background/backend-url.js
//     picks up (as its highest-priority source) at the start of every run.
const statusEl = document.getElementById('status')

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`

async function siteUrl() {
  const stored = (await chrome.storage.local.get('backendUrl')).backendUrl
  return String(stored || '').replace(/\/$/, '')
}

// Opens the dashboard in a new tab: prefers the user-configured backend URL,
// falls back to probing common local dev ports (Vite's default range), and
// finally falls back to the hosted deployment.
async function openDashboard(company) {
  const query = company ? `?company=${encodeURIComponent(company)}` : ''

  const configured = await siteUrl()
  if (configured) {
    chrome.tabs.create({ url: `${configured}/${query}` })
    return
  }

  for (const port of [5173, 5174, 5175]) {
    const reachable = await fetch(`http://localhost:${port}/`, { method: 'HEAD' })
      .then(() => true)
      .catch(() => false)
    if (reachable) {
      chrome.tabs.create({ url: `http://localhost:${port}/${query}` })
      return
    }
  }
  chrome.tabs.create({ url: `https://reddit-scrapper-ncxc.onrender.com/${query}` })
}

let lastCompany = null

// Renders the job object background/job-store.js writes — same shape the
// dashboard page receives via bridge.js's JOB relay.
function render(job) {
  if (!job) return
  lastCompany = job.company || null

  statusEl.textContent = job.company ? `${job.company}: ${job.step}` : job.step
  statusEl.className =
    job.status === 'error' ? 'panel error' : job.status === 'done' ? 'panel done' : 'panel'
}

document.getElementById('dashboardBtn').addEventListener('click', () => openDashboard(lastCompany))

chrome.storage.local.get('job', ({ job }) => render(job))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.job) render(changes.job.newValue)
})

const urlInput = document.getElementById('backendUrl')
const savedEl = document.getElementById('saved')

siteUrl().then((url) => {
  if (url) urlInput.value = url
})

// Saving here is the only way a user sets backendUrl — background/backend-url.js
// reads it back at the start of the next run via loadBackendUrl().
document.getElementById('saveBtn').addEventListener('click', async () => {
  const value = urlInput.value.trim().replace(/\/$/, '')
  await chrome.storage.local.set({ backendUrl: value })
  savedEl.textContent = value ? `Sending to ${value}` : 'Using localhost'
  setTimeout(() => {
    savedEl.textContent = ''
  }, 3000)
})
