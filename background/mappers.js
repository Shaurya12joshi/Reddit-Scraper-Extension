// Converts Reddit's raw API JSON (the "Thing" listing shapes it returns for
// posts and comments) into the flat, backend-friendly objects the rest of
// the extension works with. Only collectors.js calls into this file — every
// other module deals exclusively in the mapped shape.

export const toIso = (createdUtc) => new Date(createdUtc * 1000).toISOString()

// Reddit's post ("t3") object -> our flat post shape.
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

// Reddit's comment ("t1") object -> our flat post-like shape (comments and
// posts are stored/ingested as the same record type, distinguished by
// `type`).
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

// Walks a thread's nested comment tree (Reddit nests replies inside
// replies) and flattens it into `out`, skipping deleted/removed bodies,
// stopping once `max` comments have been collected. Used by collectors.js
// when fetching a single thread's full comment listing.
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

// Pulls just the post ("t3") children out of a Reddit listing response and
// maps each to our flat post shape — the shape every search/listing
// endpoint returns.
export const postsFrom = (data) =>
  (data?.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => mapPost(c.data))
