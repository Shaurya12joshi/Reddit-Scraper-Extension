// LEGACY — see legacy/config.js. Identical logic to background/candidates.js
// (scores + shortlists candidate subreddits by how they were discovered);
// used only by legacy/run-scrape.js.
export class Candidates {
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
