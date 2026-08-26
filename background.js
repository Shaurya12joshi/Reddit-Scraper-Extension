const DEFAULT_BACKEND_URL = 'https://reddit-scrapper-ncxc.onrender.com'
let BACKEND_URL = DEFAULT_BACKEND_URL

async function loadBackendUrl() {
  const stored = (await chrome.storage.local.get('backendUrl')).backendUrl
  BACKEND_URL = String(stored || DEFAULT_BACKEND_URL).replace(/\/$/, '')
  return BACKEND_URL
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.backendUrl) {
    BACKEND_URL = String(changes.backendUrl.newValue || DEFAULT_BACKEND_URL).replace(/\/$/, '')
  }
})

const DEPTH = { SHALLOW: 'shallow', DEEP: 'deep' }

const SEED_PAGES = 1
const BASE_SEARCH_PAGES = 3
const TOPIC_COMMUNITY_QUERIES = 1
const MAX_COMMUNITIES = 10
const MIN_EXPANSION_SLOTS = 2
const PACE_SAMPLES = 8
const COMMUNITY_LIMIT = 100
const SUB_RATE_SAMPLE = 100
const COMMENTS_PER_THREAD = 40
const MAX_RULE_FETCHES = 2
const DEEP_THREAD_LIMIT = 30
const DEEP_CONCURRENCY = 3

const DELAY_MS = 1200
const MAX_DELAY_MS = 8000
const MIN_RETRY_DELAY_MS = 1500
const RATE_LIMIT_RETRIES = 4
const MAX_BACKOFF_MS = 60_000
const JITTER_RATIO = 0.2

const WINDOW_MS = 60_000

const DEFAULT_REQUESTS_PER_WINDOW = 30
const MIN_REQUESTS_PER_WINDOW = 6
const MAX_REQUESTS_PER_WINDOW = 60

let learnedLimit = DEFAULT_REQUESTS_PER_WINDOW

let refusedAt = Infinity
let refusedAtRecordedAt = 0
const REFUSAL_MEMORY_MS = 24 * 60 * 60 * 1000

const RATE_WATCH_FLOOR = 15
const RATE_FLOOR = 5

const RUN_READ_BUDGET = 120
const MAX_POSTS_PER_COMPANY = 600

const KEEPALIVE_CHUNK_MS = 20_000

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PROFILE_CACHE_KEY = 'subProfileCache'
const RULES_CACHE_KEY = 'subRulesCache'

async function loadCache(key) {
  return (await chrome.storage.local.get(key))[key] || {}
}

async function saveCache(key, cache) {
  await chrome.storage.local.set({ [key]: cache })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function longSleep(ms) {
  let remaining = ms
  while (remaining > 0) {
    const chunk = Math.min(remaining, KEEPALIVE_CHUNK_MS)
    await sleep(chunk)
    remaining -= chunk
    if (remaining > 0) await chrome.storage.local.get('job')
  }
}

let currentDelay = DELAY_MS

const pace = () => sleep(currentDelay)

function slowDown() {
  currentDelay = Math.min(MAX_DELAY_MS, Math.round(currentDelay * 1.8))
}

function easeBack() {
  if (currentDelay > DELAY_MS) {
    currentDelay = Math.max(DELAY_MS, Math.round(currentDelay * 0.92))
  }
}

let rateRemaining = Infinity
let rateUsed = null
let rateResetAt = 0

let lockedOutUntil = 0

function noteRateHeaders(response) {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  if (Number.isFinite(remaining)) rateRemaining = remaining

  const used = Number(response.headers.get('x-ratelimit-used'))
  if (Number.isFinite(used)) rateUsed = used

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset >= 0) rateResetAt = Date.now() + reset * 1000
}

let sentAt = []

const RATE_STATE_KEY = 'rateState'

const RATE_STATE_VERSION = 3

async function loadRateState() {
  const stored = (await chrome.storage.local.get(RATE_STATE_KEY))[RATE_STATE_KEY]
  if (!stored) return
  lockedOutUntil = stored.lockedOutUntil || 0

  const now = Date.now()
  sentAt = (stored.sentAt || []).filter((at) => now - at < WINDOW_MS)

  if (stored.version !== RATE_STATE_VERSION) {
    console.warn('[scraper] discarding rate figures written by an older version; relearning from the default')
    learnedLimit = DEFAULT_REQUESTS_PER_WINDOW
    refusedAt = Infinity
    refusedAtRecordedAt = 0
    await saveRateState()
    return
  }

  if (Number.isFinite(stored.learnedLimit)) {
    learnedLimit = Math.max(
      MIN_REQUESTS_PER_WINDOW,
      Math.min(MAX_REQUESTS_PER_WINDOW, stored.learnedLimit),
    )
  }
  if (Number.isFinite(stored.refusedAt) && stored.refusedAt >= MIN_REQUESTS_PER_WINDOW) {
    const recordedAt = Number(stored.refusedAtRecordedAt) || 0
    if (recordedAt && now - recordedAt > REFUSAL_MEMORY_MS) {
      console.warn('[scraper] last refusal is over 24h old — forgetting it and re-testing the ceiling')
      refusedAt = Infinity
      refusedAtRecordedAt = 0
    } else {
      refusedAt = stored.refusedAt
      refusedAtRecordedAt = recordedAt
    }
  }
}

let lastLearnedAt = 0
const LEARN_DEBOUNCE_MS = 3000

function learnFromRefusal() {
  const now = Date.now()
  if (now - lastLearnedAt < LEARN_DEBOUNCE_MS) {
    return
  }
  lastLearnedAt = now

  const spent = sentAt.filter((at) => Date.now() - at < WINDOW_MS).length
  const meaningful = Math.max(MIN_REQUESTS_PER_WINDOW, Math.ceil(learnedLimit * 0.6))

  if (spent < meaningful) {
    console.warn(
      `[scraper] refused after only ${spent} request(s) this minute — a lockout still in ` +
        `force, not a new limit. Cap stays at ${learnedLimit}/min.`,
    )
    return
  }

  refusedAt = Math.min(refusedAt, spent)
  refusedAtRecordedAt = Date.now()
  const next = Math.floor(spent * 0.6)
  learnedLimit = Math.max(MIN_REQUESTS_PER_WINDOW, Math.min(learnedLimit - 1, next))
  console.warn(`[scraper] rate limit learned: ${spent} in the last minute was too many; now capping at ${learnedLimit}/min`)
}

function easeLimitUp() {
  const ceiling = Math.max(
    MIN_REQUESTS_PER_WINDOW,
    Math.min(
      MAX_REQUESTS_PER_WINDOW,
      refusedAt === Infinity ? MAX_REQUESTS_PER_WINDOW : refusedAt - 2,
    ),
  )
  if (learnedLimit >= ceiling) return
  learnedLimit = Math.min(ceiling, learnedLimit + 4)
}

let successStreak = 0
const RAMP_EVERY_N_SUCCESSES = 3

function maybeRampWithinRun() {
  successStreak += 1
  if (successStreak % RAMP_EVERY_N_SUCCESSES !== 0) return
  easeLimitUp()
}

async function saveRateState() {
  await chrome.storage.local.set({
    [RATE_STATE_KEY]: {
      version: RATE_STATE_VERSION,
      lockedOutUntil,
      sentAt,
      learnedLimit,
      refusedAt: Number.isFinite(refusedAt) ? refusedAt : null,
      refusedAtRecordedAt,
    },
  })
}

function windowWait() {
  const now = Date.now()
  sentAt = sentAt.filter((at) => now - at < WINDOW_MS)
  if (sentAt.length < learnedLimit) return 0
  return WINDOW_MS - (now - sentAt[0])
}

let requestLockChain = Promise.resolve()

function withRequestLock(fn) {
  const run = requestLockChain.then(fn, fn)
  requestLockChain = run.then(
    () => {},
    () => {},
  )
  return run
}

async function awaitRateWindow() {
  let wait = windowWait()

  if (!wait && rateRemaining <= RATE_FLOOR) {
    const headerWait = rateResetAt - Date.now()
    if (headerWait > 0) wait = headerWait
    else rateRemaining = Infinity
  } else if (!wait && rateRemaining <= RATE_WATCH_FLOOR) {
    const closeness = (RATE_WATCH_FLOOR - rateRemaining) / (RATE_WATCH_FLOOR - RATE_FLOOR)
    wait = Math.round(closeness * 4000)
  }

  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000)
    console.warn(
      `[scraper] pausing ${seconds}s (window ${sentAt.length}/${learnedLimit}, ` +
        `remaining=${rateRemaining}, used=${rateUsed})`,
    )
    await setJob({ step: `Staying inside Reddit's limit, pausing ${seconds}s…` })
    await longSleep(wait)
    if (rateRemaining <= RATE_FLOOR) rateRemaining = Infinity
    windowWait()
  }

  sentAt.push(Date.now())
  await saveRateState()
}

let readsUsed = 0

const hasBudget = () => readsUsed < RUN_READ_BUDGET

class BudgetExhausted extends Error {
  constructor(message) {
    super(message || 'Reached this run\'s Reddit request budget.')
    this.name = 'BudgetExhausted'
  }
}

class RateLimited extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimited'
  }
}

const isStopSignal = (error) => error instanceof BudgetExhausted || error instanceof RateLimited

const responseCache = new Map()

async function setJob(patch) {
  const { job } = await chrome.storage.local.get('job')
  await chrome.storage.local.set({
    job: { ...(job || {}), ...patch, updatedAt: Date.now() },
  })
}

function withJitter(ms) {
  return Math.round(ms + ms * JITTER_RATIO * (Math.random() * 2 - 1))
}

function retryAfterMs(response, attempt) {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(MIN_RETRY_DELAY_MS, withJitter(seconds * 1000))
    }
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(MIN_RETRY_DELAY_MS, withJitter(at - Date.now()))
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(MIN_RETRY_DELAY_MS, withJitter(reset * 1000))
  }

  return Math.max(MIN_RETRY_DELAY_MS, withJitter(2000 * 2 ** attempt))
}

async function redditJson(url, attempt = 0) {
  if (responseCache.has(url)) return responseCache.get(url)

  if (Date.now() < lockedOutUntil) {
    const minutes = Math.ceil((lockedOutUntil - Date.now()) / 60_000)
    throw new RateLimited(
      `Reddit has rate-limited this browser session for about ${minutes} more ` +
        `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost, try again after that.`,
    )
  }

  if (!hasBudget()) throw new BudgetExhausted()

  if (attempt === 0) {
    await withRequestLock(awaitRateWindow)
    readsUsed++
  }

  const response = await fetch(url, { credentials: 'include' })
  noteRateHeaders(response)

  if (response.url.includes('/login')) {
    throw new Error('Reddit redirected to login. Sign in to Reddit in this browser, then retry.')
  }

  if (response.status === 429 || response.status === 503) {
    if (attempt >= RATE_LIMIT_RETRIES) {
      throw new RateLimited(
        'Reddit is rate-limiting this browser session. Wait a few minutes and try again, ' +
          'nothing already collected was lost.',
      )
    }

    slowDown()
    learnFromRefusal()
    await saveRateState()
    const wait = retryAfterMs(response, attempt)

    if (wait > MAX_BACKOFF_MS) {
      lockedOutUntil = Date.now() + wait
      await saveRateState()
      const minutes = Math.ceil(wait / 60_000)
      throw new RateLimited(
        `Reddit has rate-limited this browser session for about ${minutes} more ` +
          `minute${minutes === 1 ? '' : 's'}. Nothing collected was lost, try again after that.`,
      )
    }

    console.warn(
      `[scraper] rate limited (${response.status}); waiting ${Math.round(wait / 1000)}s ` +
        `(attempt ${attempt + 1}/${RATE_LIMIT_RETRIES}), pace now ${currentDelay}ms`,
    )
    await setJob({
      step: `Reddit asked us to slow down, waiting ${Math.round(wait / 1000)}s…`,
    })
    await longSleep(wait)
    return redditJson(url, attempt + 1)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!response.ok || !contentType.includes('json')) {
    if (!contentType.includes('json') && (response.status === 403 || response.status === 503)) {
      console.warn(`[scraper] non-JSON response at ${response.status} — likely an edge block, not a rate limit`)
      throw new Error(
        'Reddit blocked this request at the edge (not a rate limit). This browser session may need ' +
          're-authenticating on reddit.com.',
      )
    }
    if (!response.ok) throw new Error(`Reddit responded with ${response.status}`)
  }

  easeBack()
  maybeRampWithinRun()
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('Reddit returned a response that was not valid JSON.')
  }
  responseCache.set(url, data)
  return data
}

async function redditJsonSafe(url) {
  try {
    return await redditJson(url)
  } catch (error) {
    if (isStopSignal(error)) throw error
    console.warn('[scraper] optional fetch failed:', url, error.message)
    return null
  }
}

const toIso = (createdUtc) => new Date(createdUtc * 1000).toISOString()

function mapPost(d) {
  return {
    id: d.name,
    type: 'post',
    title: d.title || '',
    body: d.selftext || '',
    author: d.author || '[deleted]',
    subreddit: d.subreddit || null,
    score: d.score ?? 0,
    numComments: d.num_comments ?? 0,
    createdAt: toIso(d.created_utc),
    permalink: d.permalink,
    url: `https://old.reddit.com${d.permalink}`,
  }
}

function mapComment(d, subreddit) {
  return {
    id: d.name,
    type: 'comment',
    title: '',
    body: d.body || '',
    author: d.author || '[deleted]',
    subreddit,
    score: d.score ?? 0,
    numComments: 0,
    createdAt: toIso(d.created_utc),
    permalink: d.permalink,
    url: d.permalink ? `https://old.reddit.com${d.permalink}` : null,
  }
}

function collectComments(listing, subreddit, out, max) {
  const children = listing?.data?.children
  if (!Array.isArray(children)) return

  for (const child of children) {
    if (out.length >= max) return
    if (child.kind !== 't1') continue

    const d = child.data
    if (!d.body || d.body === '[deleted]' || d.body === '[removed]') continue

    out.push(mapComment(d, subreddit))

    if (d.replies && typeof d.replies === 'object') {
      collectComments(d.replies, subreddit, out, max)
    }
  }
}

const postsFrom = (data) =>
  (data?.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data))

async function collect(target, depth = DEPTH.SHALLOW) {
  switch (target.kind) {
    case 'search': {
      const base = target.subreddit
        ? `https://old.reddit.com/r/${target.subreddit}/search.json?q=${encodeURIComponent(target.query)}` +
          `&restrict_sr=1&sort=${target.sort || 'new'}&t=all&limit=${target.limit || COMMUNITY_LIMIT}`
        : `https://old.reddit.com/search.json?q=${encodeURIComponent(target.query)}` +
          `&sort=${target.sort || 'relevance'}&limit=${target.limit || 100}`

      const posts = []
      let after = target.after || null
      const pages = depth === DEPTH.DEEP ? target.pages || SEED_PAGES : target.pages || 1

      for (let page = 0; page < pages; page++) {
        const url = after ? `${base}&after=${after}` : base
        const data = target.required ? await redditJson(url) : await redditJsonSafe(url)
        posts.push(...postsFrom(data))

        after = data?.data?.after
        if (!after) break
        if (page < pages - 1) await pace()
      }
      return { posts, after }
    }

    case 'communities': {
      const data = await redditJsonSafe(
        `https://old.reddit.com/subreddits/search.json?q=${encodeURIComponent(target.query)}` +
          `&limit=${target.limit || 25}`,
      )
      const names = (data?.data?.children ?? [])
        .map((child) => child?.data?.display_name)
        .filter(Boolean)
      return { names }
    }

    case 'profile': {
      const about = await redditJsonSafe(`https://old.reddit.com/r/${target.subreddit}/about.json`)
      const profile = {
        name: about?.data?.display_name || target.subreddit,
        subscribers: about?.data?.subscribers ?? null,
        activeUsers: about?.data?.active_user_count ?? null,
        title: about?.data?.public_description || about?.data?.title || null,
        subPostRate: null,
      }

      if (depth === DEPTH.DEEP) {
        await pace()
        const recent = postsFrom(
          await redditJsonSafe(
            `https://old.reddit.com/r/${target.subreddit}/new.json?limit=${SUB_RATE_SAMPLE}`,
          ),
        )
        if (recent.length >= 10) {
          const times = recent.map((post) => new Date(post.createdAt).getTime())
          const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000
          profile.subPostRate = spanDays > 0.5 ? recent.length / spanDays : null
        }
      }
      return { profile }
    }

    case 'rules': {
      const data = await redditJsonSafe(`https://old.reddit.com/r/${target.subreddit}/about/rules.json`)
      const rules = (data?.rules ?? []).map((rule) => ({
        short_name: rule.short_name,
        description: rule.description,
        kind: rule.kind,
      }))
      return { rules: { name: target.subreddit, rules } }
    }

    case 'thread': {
      if (depth !== DEPTH.DEEP) return { post: target.post, comments: [], fetched: false }

      const detail = await redditJsonSafe(
        `https://old.reddit.com${target.post.permalink}.json?limit=${COMMENTS_PER_THREAD}&sort=top`,
      )
      if (!detail) return { post: target.post, comments: [], fetched: false }

      const full = detail?.[0]?.data?.children?.[0]?.data
      const post = { ...target.post }
      if (full?.selftext) post.body = full.selftext
      if (Number.isFinite(full?.score)) post.score = full.score
      if (Number.isFinite(full?.num_comments)) post.numComments = full.num_comments

      const comments = []
      collectComments(detail?.[1], post.subreddit, comments, COMMENTS_PER_THREAD)
      return { post, comments, fetched: true }
    }

    default:
      throw new Error(`collect(): unknown target kind "${target.kind}"`)
  }
}

async function backend(path, body) {
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

const understandBrand = (company, posts, alreadySearched = []) =>
  backend('/api/understand', { company, posts, alreadySearched })

class Candidates {
  constructor() {
    this.map = new Map()
  }

  add(name, channel, weight) {
    if (!name) return
    if (!this.map.has(name)) this.map.set(name, { name, score: 0, via: new Set() })
    const entry = this.map.get(name)
    entry.score += weight
    entry.via.add(channel)
  }

  addPosts(posts, channel, weight) {
    for (const post of posts) this.add(post.subreddit, channel, weight)
  }

  shortlist(limit, reserved) {
    const all = [...this.map.values()].sort((a, b) => b.score - a.score)
    const isExpansion = (entry) =>
      ![...entry.via].some((channel) => channel === 'global' || channel === 'named')

    const facetOf = (entry) =>
      [...entry.via]
        .filter((channel) => channel.startsWith('context:') || channel.startsWith('topic:'))
        .map((channel) => channel.split(':')[1].split('/')[0])

    const picked = []
    const claimed = new Set()

    for (const entry of all) {
      if (picked.length >= limit) break
      const facets = facetOf(entry)
      if (!facets.length || facets.every((facet) => claimed.has(facet))) continue
      facets.forEach((facet) => claimed.add(facet))
      picked.push(entry)
    }

    for (const entry of all) {
      if (picked.length >= limit) break
      if (!picked.includes(entry)) picked.push(entry)
    }

    const missing = reserved - picked.filter(isExpansion).length
    if (missing <= 0) return picked

    const extras = all
      .filter((entry) => isExpansion(entry) && !picked.includes(entry))
      .slice(0, missing)
    return [...picked.slice(0, limit - extras.length), ...extras]
  }
}

async function runScrape(company) {
  await setJob({ status: 'running', company, step: 'Searching Reddit…' })

  readsUsed = 0
  successStreak = 0
  currentDelay = DELAY_MS
  rateRemaining = Infinity
  rateResetAt = 0
  responseCache.clear()

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

    const known = new Set((await backend(`/api/known-ids?company=${encodeURIComponent(company)}`))?.ids ?? [])

    const seed = await collect(
      { kind: 'search', query: company, sort: 'relevance', required: true, pages: SEED_PAGES },
      DEPTH.DEEP,
    )
    mergePosts(seed.posts)
    candidates.addPosts(seed.posts, 'global', 1)

    if (byId.size === 0) {
      await setJob({ status: 'error', step: `No Reddit posts found for "${company}".` })
      return
    }

    let understanding = null
    const communityMeta = []
    let stoppedEarly = false
    let stopReason = ''

    try {
      await pace()
      const fresh = await collect({ kind: 'search', query: company, sort: 'new' }, DEPTH.SHALLOW)
      mergePosts(fresh.posts)
      candidates.addPosts(fresh.posts, 'recent', 1.5)

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
          { kind: 'search', query: company, sort: 'relevance', pages: 1, after: cursor },
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

      const DEEP_RESERVE = DEEP_THREAD_LIMIT + MAX_RULE_FETCHES + 4

      for (const [index, candidate] of shortlist.entries()) {
        if (readsUsed > RUN_READ_BUDGET - DEEP_RESERVE) break

        const sub = candidate.name
        await setJob({ step: `Measuring r/${sub} (${index + 1}/${shortlist.length})…` })
        await pace()

        const inSub = await collect(
          { kind: 'search', query: company, subreddit: sub, sort: 'new' },
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
        `${comments.length} comments from ${deepened.length} of the ` +
        `${threadTargets.length} highest-value threads.` +
        (final?.total ? ` ${final.total} stored in total.` : '') +
        (stoppedEarly
          ? ` Stopped early: ${stopReason || 'stayed inside Reddit\'s request limit'}. ` +
            'Run it again to go deeper.'
          : ''),
      count: discovered.length + comments.length,
      partial: stoppedEarly,
      reads: readsUsed,
    })
  } catch (error) {
    if (error instanceof RateLimited) console.warn('[scraper]', error.message)
    else console.error('[scraper]', error)

    await setJob({
      status: 'error',
      step: error.message,
      rateLimited: error instanceof RateLimited,
      retryAt: error instanceof RateLimited ? lockedOutUntil || null : null,
    })
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'START_SCRAPE') return

  runScrape(message.company).catch(async (error) => {
    console.error('[scraper] run failed outright:', error)
    await setJob({ status: 'error', step: error?.message || 'The collector stopped unexpectedly.' })
  })
})
