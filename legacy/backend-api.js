// LEGACY — see legacy/config.js. Same role as background/backend-api.js
// (talks to Mercuric's own backend), but the URL is a fixed constant
// instead of the dynamic popup/dashboard-aware lookup in backend-url.js.
import { BACKEND_URL } from './config.js'

export async function backend(path, body) {
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) return null
    return await response.json()
  } catch (error) {
    console.warn('[scraper] backend call failed:', path, error.message)
    return null
  }
}

export const understandBrand = (company, posts, alreadySearched = []) =>
  backend('/api/understand', { company, posts, alreadySearched })
