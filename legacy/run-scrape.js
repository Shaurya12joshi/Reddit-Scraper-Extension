// LEGACY — see legacy/config.js. The old runScrape orchestrator, before the
// company-scrape flow gained a field-scan phase, subreddit profile/rules
// caching, a MAX_POSTS_PER_COMPANY cap, and parallel deep-phase thread
// reads (compare against background/run-scrape.js, which has all of those).
// This version: takes only `company` (no keywords), asks the backend twice
// for follow-up search queries (runFacetQueries, round one + a second round
// after showing the backend what's already been searched) plus alias
// queries, and reads deep-phase threads one at a time in a plain loop.
import {
  DEPTH,
  SEED_PAGES,
  ROUND_ONE_QUERIES,
  ROUND_TWO_QUERIES,
  TOPIC_COMMUNITY_QUERIES,
  ALIAS_QUERIES,
  MAX_COMMUNITIES,
  MIN_EXPANSION_SLOTS,
  PACE_SAMPLES,
  COMMUNITY_LIMIT,
  MAX_RULE_FETCHES,
  RUN_READ_BUDGET,
} from './config.js'
import { setJob } from './job-store.js'
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
import { backend, understandBrand } from './backend-api.js'
import { collect } from './collectors.js'
import { Candidates } from './candidates.js'
import { RateLimited, isStopSignal } from './errors.js'

export async function runScrape(company) {
  await setJob({ status: 'running', company, step: 'Searching Reddit…' })

  resetForRun()
  clearResponseCache()

  await loadRateState()

  try {
    const byId = new Map()
    const candidates = new Candidates()

    const known = new Set((await backend(`/api/known-ids?company=${encodeURIComponent(company)}`))?.ids ?? [])

    const seed = await collect(
      { kind: 'search', query: company, sort: 'relevance', required: true, pages: SEED_PAGES },
      DEPTH.DEEP,
    )
    for (const post of seed.posts) byId.set(post.id, post)
    candidates.addPosts(seed.posts, 'global', 1)

    if (byId.size === 0) {
      await setJob({ status: 'error', step: `No Reddit posts found for "${company}".` })
      return
    }

    let understanding = null
    const communityMeta = []
    let stoppedEarly = false

    try {
      await pace()
      const fresh = await collect({ kind: 'search', query: company, sort: 'new' }, DEPTH.SHALLOW)
      for (const post of fresh.posts) byId.set(post.id, post)
      candidates.addPosts(fresh.posts, 'recent', 1.5)

      await setJob({ step: `${byId.size} posts. Working out what people discuss…` })
      understanding = await understandBrand(company, [...byId.values()])
      const aliases = (understanding?.aliases ?? []).map((entry) => entry.alias)

      await pace()
      const named = await collect({ kind: 'communities', query: company }, DEPTH.SHALLOW)
      for (const name of named.names) candidates.add(name, 'named', 5)

      for (const alias of aliases.slice(0, ALIAS_QUERIES)) {
        if (!hasBudget()) break
        await pace()
        await setJob({ step: `Searching for "${alias}" (an alias people use)…` })
        const hits = await collect({ kind: 'search', query: alias, sort: 'relevance' }, DEPTH.SHALLOW)
        for (const post of hits.posts) byId.set(post.id, post)
        candidates.addPosts(hits.posts, `alias:${alias}`, 1.5)
      }

      const searched = []
      async function runFacetQueries(queries) {
        for (const { term, facet } of queries) {
          if (!hasBudget()) break
          await pace()
          await setJob({ step: `Exploring "${company} ${term}" (${facet})…` })
          const hits = await collect(
            { kind: 'search', query: `${company} ${term}`, sort: 'relevance' },
            DEPTH.SHALLOW,
          )
          for (const post of hits.posts) byId.set(post.id, post)
          candidates.addPosts(hits.posts, `context:${facet}/${term}`, 1.5)
          searched.push(term)
        }
      }

      await runFacetQueries((understanding?.queries ?? []).slice(0, ROUND_ONE_QUERIES))

      if (understanding) {
        await setJob({ step: `${byId.size} posts. Looking for corners still unexplored…` })
        const second = await understandBrand(company, [...byId.values()], searched)
        if (second?.queries?.length) {
          understanding = second
          await runFacetQueries(second.queries.slice(0, ROUND_TWO_QUERIES))
        }
      }

      for (const facet of (understanding?.facets ?? []).slice(0, TOPIC_COMMUNITY_QUERIES)) {
        if (!hasBudget()) break
        await pace()
        const found = await collect({ kind: 'communities', query: facet.label, limit: 10 }, DEPTH.SHALLOW)
        for (const name of found.names) candidates.add(name, `topic:${facet.label}`, 2)
      }

      const shortlist = candidates.shortlist(MAX_COMMUNITIES, MIN_EXPANSION_SLOTS)

      for (const [index, candidate] of shortlist.entries()) {
        if (getReadsUsed() > RUN_READ_BUDGET - 30) break

        const sub = candidate.name
        await setJob({ step: `Measuring r/${sub} (${index + 1}/${shortlist.length})…` })
        await pace()

        const inSub = await collect(
          { kind: 'search', query: company, subreddit: sub, sort: 'new' },
          DEPTH.SHALLOW,
        )

        if (inSub.posts.length < 2) continue
        for (const post of inSub.posts) byId.set(post.id, post)

        const timestamps = inSub.posts.map((post) => new Date(post.createdAt).getTime())

        await pace()
        const { profile } = await collect(
          { kind: 'profile', subreddit: sub },
          communityMeta.length < PACE_SAMPLES ? DEPTH.DEEP : DEPTH.SHALLOW,
        )

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
      console.warn('[scraper] discovery stopped early:', error.message)
    }

    const discovered = [...byId.values()]

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
      throw new Error('Backend did not accept the discovery data — is the server running on :3001?')
    }

    await setJob({ step: 'Working out which discussions matter…' })
    const plan = await backend(`/api/collection-plan?company=${encodeURIComponent(company)}`)
    const threadTargets = plan?.threads ?? []
    const ruleTargets = (plan?.rules ?? []).slice(0, MAX_RULE_FETCHES)

    const comments = []
    const deepened = []

    try {
      for (const [index, target] of threadTargets.entries()) {
        if (!hasBudget()) {
          stoppedEarly = true
          break
        }

        await setJob({
          step: `Reading discussion ${index + 1}/${threadTargets.length} (${comments.length} comments)…`,
        })
        await pace()

        const result = await collect({ kind: 'thread', post: target }, DEPTH.DEEP)
        if (!result.fetched) continue
        if (result.comments.length) comments.push(...result.comments)
        deepened.push(result.post)
      }
    } catch (error) {
      if (!isStopSignal(error)) throw error
      stoppedEarly = true
      console.warn('[scraper] deep phase stopped early:', error.message)
    }

    const rules = []
    try {
      for (const sub of ruleTargets) {
        if (!hasBudget()) {
          stoppedEarly = true
          break
        }
        await pace()
        const result = await collect({ kind: 'rules', subreddit: sub }, DEPTH.SHALLOW)
        if (result.rules) rules.push(result.rules)
      }
    } catch (error) {
      if (!isStopSignal(error)) throw error
      stoppedEarly = true
      console.warn('[scraper] rule fetching stopped early:', error.message)
    }

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
        `Done — ${discovered.length} posts across ${subCount} subreddits, ` +
        `${comments.length} comments from ${deepened.length} of the ` +
        `${threadTargets.length} highest-value threads.` +
        (final?.total ? ` ${final.total} stored in total.` : '') +
        (stoppedEarly
          ? ' Stopped early to stay inside Reddit\'s request limit — run it again later to go deeper.'
          : ''),
      count: discovered.length + comments.length,
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
