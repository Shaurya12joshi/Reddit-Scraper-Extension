// Entry point for a "field-only" scan — mapping an industry/keyword field on
// Reddit with no specific company attached. Triggered from
// background/index.js when the incoming START_SCRAPE message has
// `fieldOnly: true` (set by the dashboard when the user searches by
// keywords instead of a company name). Simpler than run-scrape.js: one
// phase, no subreddit discovery/scoring, no deep thread reading.
import { DEPTH, FIELD_QUERIES } from './config.js'
import { setJob } from './job-store.js'
import { phraseQuery } from './http-util.js'
import { resetForRun, hasBudget, pace, loadRateState, saveRateState } from './rate-limiter.js'
import { clearResponseCache } from './reddit-client.js'
import { loadBackendUrl } from './backend-url.js'
import { backend } from './backend-api.js'
import { collect } from './collectors.js'

export async function runFieldScan(field) {
  await setJob({ status: 'running', company: field, step: `Mapping the ${field} field…` })

  resetForRun()
  clearResponseCache()

  await loadBackendUrl()
  await loadRateState()

  try {
    // Ask the backend for search queries that map out this field/industry
    // (e.g. "field" = "project management software" -> a handful of
    // relevant search terms).
    const plan = await backend(`/api/field-plan?keywords=${encodeURIComponent(field)}`)
    const queries = plan?.queries ?? []

    if (!queries.length) {
      await setJob({ status: 'error', step: `Could not map the "${field}" field.` })
      return
    }

    const posts = new Map()

    // Run each suggested query and merge results by post id (dedupes posts
    // that multiple queries surface).
    for (const query of queries.slice(0, FIELD_QUERIES + 4)) {
      if (!hasBudget()) break
      await pace()
      await setJob({ step: `Searching the field: ${query.term}…` })
      const hits = await collect(
        { kind: 'search', query: phraseQuery(query.term), sort: 'relevance' },
        DEPTH.SHALLOW,
      )
      for (const post of hits.posts) posts.set(post.id, post)
    }

    if (!posts.size) {
      await setJob({ status: 'error', step: `No Reddit discussions found about ${field}.` })
      return
    }

    await setJob({ step: `Saving ${posts.size} field discussions…` })
    const final = await backend('/api/ingest', {
      company: field,
      posts: [...posts.values()],
      scope: 'field',
      phase: 'field',
    })

    const subCount = new Set([...posts.values()].map((post) => post.subreddit)).size
    await setJob({
      status: 'done',
      step:
        `Done: ${posts.size} discussions about ${field} across ${subCount} subreddits.` +
        (final?.total ? ` ${final.total} stored in total.` : ''),
      count: posts.size,
      collected: posts.size,
      fieldCollected: posts.size,
      stored: final?.total ?? null,
    })
  } catch (error) {
    console.error('[scraper] field scan failed:', error)
    await setJob({ status: 'error', step: error?.message || 'The field scan stopped unexpectedly.' })
  } finally {
    // Persist whatever the rate limiter learned this run even on failure,
    // so a crashed run still leaves useful pacing data for next time.
    await saveRateState()
  }
}
