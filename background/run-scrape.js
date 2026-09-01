// Entry point for a full company scrape — the biggest orchestrator in the
// extension. Triggered from background/index.js on a plain (non-fieldOnly)
// START_SCRAPE message. Runs in phases, each wrapped so a stop signal
// (BudgetExhausted/RateLimited, see errors.js) ends that phase early but
// keeps whatever was already collected instead of losing the whole run:
//
//   1. Seed search for the company name (required — if this finds nothing
//      and there's no keywords fallback, the run ends here).
//   2. Optional field/industry scan alongside the company search, when the
//      caller passed `keywords`.
//   3. Discovery: a fresh/recent search, backend "brand understanding"
//      round-trip for follow-up queries, subreddit candidate scoring
//      (candidates.js), and a shortlist of subreddits to profile.
//   4. Ingest discovery results, then ask the backend which threads/
//      subreddits are worth reading in full (collection plan).
//   5. Deep phase: read the shortlisted threads' full comments (in
//      parallel, DEEP_CONCURRENCY workers) and fetch a few subreddits'
//      rules.
//   6. Final ingest of the deep-phase data, and a summary job update.
import {
  DEPTH,
  SEED_PAGES,
  BASE_SEARCH_PAGES,
  TOPIC_COMMUNITY_QUERIES,
  MAX_COMMUNITIES,
  MIN_EXPANSION_SLOTS,
  PACE_SAMPLES,
  COMMUNITY_LIMIT,
  MAX_RULE_FETCHES,
  FIELD_QUERIES,
  DEEP_THREAD_LIMIT,
  DEEP_CONCURRENCY,
  PROFILE_TTL_MS,
  PROFILE_CACHE_KEY,
  RULES_CACHE_KEY,
  RUN_READ_BUDGET,
  MAX_POSTS_PER_COMPANY,
} from './config.js'
import { setJob } from './job-store.js'
import { phraseQuery } from './http-util.js'
import {
  resetForRun,
  hasBudget,
  pace,
  getReadsUsed,
  getLockedOutUntil,
  easeLimitUp,
  loadRateState,
  saveRateState,
} from './rate-limiter.js'
import { clearResponseCache } from './reddit-client.js'
import { loadBackendUrl } from './backend-url.js'
import { backend, understandBrand } from './backend-api.js'
import { collect } from './collectors.js'
import { Candidates } from './candidates.js'
import { loadCache, saveCache } from './cache-store.js'
import { RateLimited, isStopSignal } from './errors.js'

export async function runScrape(company, keywords = '') {
  await setJob({ status: 'running', company, step: 'Searching Reddit…' })

  resetForRun()
  clearResponseCache()

  await loadBackendUrl()
  await loadRateState()

  try {
    const byId = new Map()
    const candidates = new Candidates()

    const mergePosts = (posts) => {
      for (const post of posts) {
        if (byId.size >= MAX_POSTS_PER_COMPANY && !byId.has(post.id)) continue
        byId.set(post.id, post)
      }
    }

    // Posts the backend already has stored for this company — used later to
    // avoid re-sending duplicates on ingest.
    const known = new Set((await backend(`/api/known-ids?company=${encodeURIComponent(company)}`))?.ids ?? [])
    const fieldPosts = new Map()

    // Phase 1: the required seed search. `required: true` means a failure
    // here throws instead of being swallowed — without this, there's
    // nothing to build a report from.
    const seed = await collect(
      { kind: 'search', query: phraseQuery(company), sort: 'relevance', required: true, pages: SEED_PAGES },
      DEPTH.DEEP,
    )
    mergePosts(seed.posts)
    candidates.addPosts(seed.posts, 'global', 1)

    // Phase 2 (optional): if the caller also gave a field/industry keyword,
    // run a parallel field scan and ingest it separately (scope: 'field')
    // so the dashboard can show field-wide context even for a company with
    // little direct Reddit presence.
    let fieldPlan = null
    if (keywords) {
      await setJob({ step: `Mapping the ${keywords} field…` })
      fieldPlan = await backend(
        `/api/field-plan?keywords=${encodeURIComponent(keywords)}` +
          `&company=${encodeURIComponent(company)}`,
      )

      for (const query of (fieldPlan?.queries ?? []).slice(0, FIELD_QUERIES)) {
        if (!hasBudget()) break
        await pace()
        await setJob({ step: `Searching the field: ${query.term}…` })
        const hits = await collect(
          { kind: 'search', query: phraseQuery(query.term), sort: 'relevance' },
          DEPTH.SHALLOW,
        )
        for (const post of hits.posts) {
          if (!byId.has(post.id)) fieldPosts.set(post.id, post)
        }
        candidates.addPosts(hits.posts, `field:${query.kind}`, 1.2)
      }

      if (fieldPosts.size) {
        await setJob({ step: `Saving ${fieldPosts.size} field discussions…` })
        await backend('/api/ingest', {
          company,
          posts: [...fieldPosts.values()],
          scope: 'field',
          phase: 'field',
        })
      }
    }

    if (byId.size === 0 && fieldPosts.size > 0) {
      await setJob({
        status: 'done',
        step:
          `No Reddit threads mention "${company}" itself, but ${fieldPosts.size} discussions ` +
          'about its field were collected. The report covers the field.',
        count: fieldPosts.size,
        collected: fieldPosts.size,
        fieldCollected: fieldPosts.size,
      })
      return
    }

    if (byId.size === 0) {
      await setJob({
        status: 'error',
        step:
          `Reddit returned no results for "${company}"` +
          (keywords ? ' or its field' : '') +
          '. Open reddit.com in this browser and check you are signed in and not being ' +
          'shown a block or consent page, then run it again.',
      })
      return
    }

    let understanding = null
    const communityMeta = []
    let stoppedEarly = false
    let stopReason = ''

    // Phase 3: discovery. Wrapped in try/catch so a BudgetExhausted or
    // RateLimited partway through still lets the run fall through to
    // ingesting whatever was found (stoppedEarly / stopReason feed the
    // final job summary).
    try {
      await pace()
      const fresh = await collect({ kind: 'search', query: phraseQuery(company), sort: 'new' }, DEPTH.SHALLOW)
      mergePosts(fresh.posts)
      candidates.addPosts(fresh.posts, 'recent', 1.5)

      // Hand what's been found so far to the backend, which reads it and
      // suggests topic "facets" (candidate subreddit search terms) plus
      // brand context used later in the final report.
      await setJob({ step: `${byId.size} posts. Working out what people discuss…` })
      understanding = await understandBrand(company, [...byId.values()])

      await pace()
      const named = await collect({ kind: 'communities', query: company }, DEPTH.SHALLOW)
      for (const name of named.names) candidates.add(name, 'named', 5)

      let cursor = null
      for (let page = 0; page < BASE_SEARCH_PAGES; page += 1) {
        if (!hasBudget()) break
        if (page > 0 && !cursor) break
        await pace()
        await setJob({ step: `Reading more of the ${company} discussion (page ${page + 1}/${BASE_SEARCH_PAGES})…` })
        const hits = await collect(
          { kind: 'search', query: phraseQuery(company), sort: 'relevance', pages: 1, after: cursor },
          DEPTH.SHALLOW,
        )
        mergePosts(hits.posts)
        candidates.addPosts(hits.posts, 'base', 1.3)
        cursor = hits.after
      }

      for (const facet of (understanding?.facets ?? []).slice(0, TOPIC_COMMUNITY_QUERIES)) {
        if (!hasBudget()) break
        await pace()
        const found = await collect({ kind: 'communities', query: facet.label, limit: 10 }, DEPTH.SHALLOW)
        for (const name of found.names) candidates.add(name, `topic:${facet.label}`, 2)
      }

      const shortlist = candidates.shortlist(MAX_COMMUNITIES, MIN_EXPANSION_SLOTS)
      const profileCache = await loadCache(PROFILE_CACHE_KEY)

      // Stop measuring subreddits early enough to leave budget for the deep
      // phase (thread reads + rule fetches) that comes after ingest.
      const DEEP_RESERVE = DEEP_THREAD_LIMIT + MAX_RULE_FETCHES + 4

      // Measure each shortlisted subreddit: how many company-mention posts
      // it has, and its profile (subscriber count / activity), pulling the
      // profile from cache-store.js's cache when a recent one exists so a
      // subreddit already measured this week isn't re-fetched.
      for (const [index, candidate] of shortlist.entries()) {
        if (getReadsUsed() > RUN_READ_BUDGET - DEEP_RESERVE) break

        const sub = candidate.name
        await setJob({ step: `Measuring r/${sub} (${index + 1}/${shortlist.length})…` })
        await pace()

        const inSub = await collect(
          { kind: 'search', query: phraseQuery(company), subreddit: sub, sort: 'new' },
          DEPTH.SHALLOW,
        )

        if (inSub.posts.length < 2) continue
        mergePosts(inSub.posts)

        const timestamps = inSub.posts.map((post) => new Date(post.createdAt).getTime())

        const cacheKey = sub
        const cached = profileCache[cacheKey] || profileCache[`${company}:${sub}`]
        let profile
        if (cached && Date.now() - cached.measuredAt < PROFILE_TTL_MS) {
          profile = cached.profile
        } else {
          await pace()
          ;({ profile } = await collect(
            { kind: 'profile', subreddit: sub },
            communityMeta.length < PACE_SAMPLES ? DEPTH.DEEP : DEPTH.SHALLOW,
          ))
          profileCache[cacheKey] = { profile, measuredAt: Date.now() }
          await saveCache(PROFILE_CACHE_KEY, profileCache)
        }

        communityMeta.push({
          ...profile,
          discoveredVia: [...candidate.via].join(','),
          brandHits: inSub.posts.length,
          coverageStart: timestamps.length ? Math.min(...timestamps) : null,
          sampleCapped: inSub.posts.length >= COMMUNITY_LIMIT,
        })
      }
    } catch (error) {
      if (!isStopSignal(error)) throw error
      stoppedEarly = true
      stopReason = stopReason || error.message
      console.warn('[scraper] discovery stopped early:', error.message)
    }

    const discovered = [...byId.values()]

    // Phase 4: ingest the discovery-phase results, then ask the backend
    // which threads/subreddits are worth a deeper look (it ranks by
    // whatever signals it uses — engagement, relevance, etc).
    const unseen = discovered.filter((post) => !known.has(post.id))
    const skipped = discovered.length - unseen.length

    await setJob({
      step: skipped
        ? `Saving ${unseen.length} new posts (${skipped} already stored)…`
        : `Saving ${unseen.length} posts…`,
    })

    const ingest = await backend('/api/ingest', {
      company,
      posts: unseen,
      subreddits: communityMeta,
      brandContext: understanding || null,
      phase: 'discovery',
    })
    if (!ingest) {
      throw new Error('Backend did not accept the discovery data. Is the server running on :3001?')
    }

    await setJob({ step: 'Working out which discussions matter…' })
    const plan = await backend(
      `/api/collection-plan?company=${encodeURIComponent(company)}&limit=${DEEP_THREAD_LIMIT}`,
    )
    const threadTargets = plan?.threads ?? []
    const ruleTargets = (plan?.rules ?? []).slice(0, MAX_RULE_FETCHES)

    const comments = []
    const deepened = []

    // Phase 5a: read the shortlisted threads' full comments. `cursor` is a
    // shared index into threadTargets so DEEP_CONCURRENCY workers can pull
    // from the same queue without reading the same thread twice.
    try {
      let cursor = 0
      let read = 0

      const readThreads = async () => {
        while (cursor < threadTargets.length) {
          if (!hasBudget()) {
            stoppedEarly = true
            return
          }

          const target = threadTargets[cursor++]

          await setJob({
            step: `Reading discussion ${++read}/${threadTargets.length} (${comments.length} comments)…`,
          })
          await pace()

          const result = await collect({ kind: 'thread', post: target }, DEPTH.DEEP)
          if (!result.fetched) continue
          if (result.comments.length) comments.push(...result.comments)
          deepened.push(result.post)
        }
      }

      const workers = Array.from(
        { length: Math.min(DEEP_CONCURRENCY, threadTargets.length) },
        () =>
          readThreads().catch((error) => {
            if (!isStopSignal(error)) throw error
            stoppedEarly = true
            stopReason = stopReason || error.message
            cursor = threadTargets.length
          }),
      )

      const outcomes = await Promise.allSettled(workers)
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed) throw failed.reason
    } catch (error) {
      if (!isStopSignal(error)) throw error
      stoppedEarly = true
      stopReason = stopReason || error.message
      console.warn('[scraper] deep phase stopped early:', error.message)
    }

    // Phase 5b: fetch posting rules for a few of the plan's subreddits,
    // reusing cache-store.js's cache the same way profiles do above.
    const rules = []
    try {
      const rulesCache = await loadCache(RULES_CACHE_KEY)
      for (const sub of ruleTargets) {
        const cacheKey = sub
        const cached = rulesCache[cacheKey] || rulesCache[`${company}:${sub}`]
        if (cached && Date.now() - cached.measuredAt < PROFILE_TTL_MS) {
          rules.push(cached.rules)
          continue
        }

        if (!hasBudget()) {
          stoppedEarly = true
          break
        }
        await pace()
        const result = await collect({ kind: 'rules', subreddit: sub }, DEPTH.SHALLOW)
        if (result.rules) {
          rules.push(result.rules)
          rulesCache[cacheKey] = { rules: result.rules, measuredAt: Date.now() }
          await saveCache(RULES_CACHE_KEY, rulesCache)
        }
      }
    } catch (error) {
      if (!isStopSignal(error)) throw error
      stoppedEarly = true
      stopReason = stopReason || error.message
      console.warn('[scraper] rule fetching stopped early:', error.message)
    }

    // Phase 6: final ingest of deep-phase data, then a job summary the
    // popup/dashboard render. A clean finish (no stop signal anywhere)
    // nudges the learned rate limit back up for next time.
    await setJob({ step: `Saving ${comments.length} comments…` })
    const final = await backend('/api/ingest', {
      company,
      posts: [...deepened, ...comments],
      rules,
      phase: 'deep',
    })

    if (!stoppedEarly) {
      easeLimitUp()
      await saveRateState()
    }

    const subCount = new Set(discovered.map((p) => p.subreddit)).size
    await setJob({
      status: 'done',
      step:
        `Done: ${discovered.length} posts across ${subCount} subreddits, ` +
        (fieldPosts.size ? `${fieldPosts.size} from the wider field, ` : '') +
        `${comments.length} comments from ${deepened.length} of the ` +
        `${threadTargets.length} highest-value threads.` +
        (final?.total ? ` ${final.total} stored in total.` : '') +
        (stoppedEarly
          ? ` Stopped early: ${stopReason || 'stayed inside Reddit\'s request limit'}. ` +
            'Run it again to go deeper.'
          : ''),
      count: discovered.length + comments.length,
      collected: discovered.length + comments.length,
      fieldCollected: fieldPosts.size,
      stored: final?.total ?? null,
      partial: stoppedEarly,
      reads: getReadsUsed(),
    })
  } catch (error) {
    if (error instanceof RateLimited) console.warn('[scraper]', error.message)
    else console.error('[scraper]', error)

    await setJob({
      status: 'error',
      step: error.message,
      rateLimited: error instanceof RateLimited,
      retryAt: error instanceof RateLimited ? getLockedOutUntil() || null : null,
    })
  }
}
