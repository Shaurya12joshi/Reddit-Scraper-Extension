const statusEl = document.getElementById('status')

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`

async function siteUrl() {
  const stored = (await chrome.storage.local.get('backendUrl')).backendUrl
  return String(stored || '').replace(/\/$/, '')
}

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

document.getElementById('saveBtn').addEventListener('click', async () => {
  const value = urlInput.value.trim().replace(/\/$/, '')
  await chrome.storage.local.set({ backendUrl: value })
  savedEl.textContent = value ? `Sending to ${value}` : 'Using localhost'
  setTimeout(() => {
    savedEl.textContent = ''
  }, 3000)
})
