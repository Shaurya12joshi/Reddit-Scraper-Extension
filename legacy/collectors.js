// LEGACY — see legacy/config.js. Same role as background/collectors.js (the
// single fetch dispatcher legacy/run-scrape.js calls into), but simpler:
// the 'search' case builds its URL against old.reddit.com directly (no
// searchJson/multi-host fallback) and ignores target.after, and SHALLOW
// search is hardcoded to exactly 1 page rather than reading target.pages.
import { DEPTH, SEED_PAGES, COMMUNITY_LIMIT, SUB_RATE_SAMPLE, COMMENTS_PER_THREAD } from './config.js'
import { pace } from './rate-limiter.js'
import { redditJson, redditJsonSafe } from './reddit-client.js'
import { postsFrom, collectComments } from './mappers.js'

export async function collect(target, depth = DEPTH.SHALLOW) {
  switch (target.kind) {
    case 'search': {
      const base = target.subreddit
        ? `https://old.reddit.com/r/${target.subreddit}/search.json?q=${encodeURIComponent(target.query)}` +
          `&restrict_sr=1&sort=${target.sort || 'new'}&t=all&limit=${target.limit || COMMUNITY_LIMIT}`
        : `https://old.reddit.com/search.json?q=${encodeURIComponent(target.query)}` +
          `&sort=${target.sort || 'relevance'}&limit=${target.limit || 100}`

      const posts = []
      let after = null
      const pages = depth === DEPTH.DEEP ? target.pages || SEED_PAGES : 1

      for (let page = 0; page < pages; page++) {
        const url = after ? `${base}&after=${after}` : base
        const data = target.required ? await redditJson(url) : await redditJsonSafe(url)
        posts.push(...postsFrom(data))

        after = data?.data?.after
        if (!after) break
        await pace()
      }
      return { posts }
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
