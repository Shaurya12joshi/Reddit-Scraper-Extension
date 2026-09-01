// The single fetch dispatcher: collect({ kind, ... }, depth) knows how to
// fetch every shape of Reddit data the scraper needs, and is the only thing
// run-scrape.js / run-field-scan.js call to actually touch Reddit — they
// never build a reddit-client.js URL themselves. `depth` (DEPTH.SHALLOW /
// DEEP, config.js) controls how thorough each kind's fetch is (extra pages,
// extra sampling requests) versus how many Reddit requests it costs.
import { DEPTH, SEED_PAGES, COMMUNITY_LIMIT, SUB_RATE_SAMPLE, COMMENTS_PER_THREAD } from './config.js'
import { pace } from './rate-limiter.js'
import { searchJson, redditJsonSafe } from './reddit-client.js'
import { postsFrom, collectComments } from './mappers.js'

export async function collect(target, depth = DEPTH.SHALLOW) {
  switch (target.kind) {
    // Search Reddit (site-wide, or restricted to one subreddit) for a
    // query. DEEP walks multiple result pages via Reddit's `after` cursor;
    // SHALLOW (or an explicit target.pages) reads however many pages are
    // asked for and stops early once there's no next page.
    case 'search': {
      const path = target.subreddit
        ? `/r/${target.subreddit}/search.json?q=${encodeURIComponent(target.query)}` +
          `&restrict_sr=1&sort=${target.sort || 'new'}&t=all&limit=${target.limit || COMMUNITY_LIMIT}`
        : `/search.json?q=${encodeURIComponent(target.query)}` +
          `&sort=${target.sort || 'relevance'}&limit=${target.limit || 100}`

      const posts = []
      let after = target.after || null
      const pages = depth === DEPTH.DEEP ? target.pages || SEED_PAGES : target.pages || 1

      for (let page = 0; page < pages; page++) {
        const suffix = after ? `&after=${after}` : ''
        const data = await searchJson(`${path}${suffix}`, { required: target.required })
        posts.push(...postsFrom(data))

        after = data?.data?.after
        if (!after) break
        if (page < pages - 1) await pace()
      }
      return { posts, after }
    }

    // Reddit's subreddit-name search — used by candidates.js callers (via
    // run-scrape.js) to turn a company name or topic label into a list of
    // subreddit names worth scoring as candidates.
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

    // Fetches a subreddit's about-page stats (subscriber/active-user
    // counts). At DEEP depth also samples its /new listing to estimate a
    // posts-per-day rate — used by run-scrape.js to describe how active a
    // candidate subreddit is, without doing that extra sampling for every
    // subreddit on the shortlist (only the first PACE_SAMPLES get DEEP).
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

    // A subreddit's posting rules — fetched for a small number of
    // shortlisted subreddits so the backend can factor "will this
    // community even allow this kind of post" into its report.
    case 'rules': {
      const data = await redditJsonSafe(`https://old.reddit.com/r/${target.subreddit}/about/rules.json`)
      const rules = (data?.rules ?? []).map((rule) => ({
        short_name: rule.short_name,
        description: rule.description,
        kind: rule.kind,
      }))
      return { rules: { name: target.subreddit, rules } }
    }

    // Fetches a single thread's full body + top-level comment tree. Only
    // meaningful at DEEP depth (used for the backend's shortlisted
    // "highest-value" threads) — at SHALLOW it's a no-op that just echoes
    // the post back unfetched, since scanning every discovered post's full
    // thread would blow the request budget for no benefit.
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
