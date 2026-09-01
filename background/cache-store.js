// Generic get/set helpers over a single chrome.storage.local key holding an
// object used as a cache. run-scrape.js uses this twice: once under
// PROFILE_CACHE_KEY (subreddit about-page + post-rate data) and once under
// RULES_CACHE_KEY (subreddit rules) — see config.js for the keys and
// PROFILE_TTL_MS for how long an entry stays valid before being re-fetched.
export async function loadCache(key) {
  return (await chrome.storage.local.get(key))[key] || {}
}

export async function saveCache(key, cache) {
  await chrome.storage.local.set({ [key]: cache })
}
