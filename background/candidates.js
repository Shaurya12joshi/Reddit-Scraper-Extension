// Scores every subreddit run-scrape.js discovers during a run, based on how
// and how often it turned up — a direct company-name search hit scores
// differently than a subreddit merely found via a topic search — then picks
// a shortlist for the (expensive) profile/deep-dive phase.
//
// Only run-scrape.js uses this class; it's the thing that decides *which*
// subreddits are worth spending the run's limited request budget on.
export class Candidates {
  constructor() {
    this.map = new Map()
  }

  // Records one sighting of a subreddit: `channel` is a free-form tag
  // describing how it was found (e.g. 'global', 'named', 'topic:pricing',
  // 'context:facet/term') and `weight` is how much that sighting counts.
  // A subreddit found via multiple channels accumulates score from each.
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

  // Picks up to `limit` candidates for the deep-dive shortlist. Two passes:
  // first greedily takes the highest-scoring entry for each distinct
  // "facet" (topic/context channel) seen, so the shortlist covers different
  // angles instead of just the single most-mentioned subreddit; then fills
  // any remaining slots by raw score. Finally guarantees at least `reserved`
  // slots go to subreddits found purely through expansion (topic/context/
  // alias searches) rather than direct company/name hits, so discovery
  // doesn't collapse to "subreddits that already mention the company."
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
