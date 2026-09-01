// LEGACY — see legacy/config.js. Same setJob() contract as
// background/job-store.js: merges a patch into chrome.storage.local's
// 'job' key, which popup.js/bridge.js watch via chrome.storage.onChanged.
export async function setJob(patch) {
  const { job } = await chrome.storage.local.get('job')
  await chrome.storage.local.set({
    job: { ...(job || {}), ...patch, updatedAt: Date.now() },
  })
}
