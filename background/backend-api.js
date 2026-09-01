// Talks to Mercuric's own backend server (not Reddit) — the place collected
// posts get ingested, and the source of the search-query suggestions and
// collection plans that steer run-scrape.js / run-field-scan.js. Which
// server to hit comes from backend-url.js's getBackendUrl().
import { getBackendUrl } from './backend-url.js'

// Generic GET (no body) / POST (with body) helper. Any failure — network
// error or non-2xx response — resolves to null rather than throwing, so
// callers can treat a backend hiccup as "no data" instead of crashing the
// whole run.
export async function backend(path, body) {
  try {
    const response = await fetch(`${getBackendUrl()}${path}`, {
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

// Sends the posts collected so far to the backend's brand-understanding
// endpoint, which returns follow-up search queries and topic "facets" to
// explore — run-scrape.js uses these to widen discovery beyond the initial
// company-name search. `alreadySearched` lets the backend avoid suggesting
// a query already tried.
export const understandBrand = (company, posts, alreadySearched = []) =>
  backend('/api/understand', { company, posts, alreadySearched })
