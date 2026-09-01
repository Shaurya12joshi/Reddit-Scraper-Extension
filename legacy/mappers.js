// LEGACY — see legacy/config.js. Identical to background/mappers.js: turns
// Reddit's raw post/comment JSON into the flat shape the rest of this old
// version works with. Used only by legacy/collectors.js.
export const toIso = (createdUtc) => new Date(createdUtc * 1000).toISOString()

export function mapPost(d) {
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

export function mapComment(d, subreddit) {
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

export function collectComments(listing, subreddit, out, max) {
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

export const postsFrom = (data) =>
  (data?.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data))
