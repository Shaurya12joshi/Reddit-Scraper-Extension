function parseCount(text) {
  if (!text) return null
  const match = text.replace(/,/g, '').match(/\d+/)
  return match ? parseInt(match[0], 10) : null
}

const posts = []

document.querySelectorAll('.search-result-link').forEach((el) => {
  const titleA = el.querySelector('a.search-title')
  const commentsA = el.querySelector('.search-comments')
  if (!titleA || !commentsA) return

  const subA = el.querySelector('a.search-subreddit-link')
  const authorA = el.querySelector('a.author')
  const scoreEl = el.querySelector('.search-score')
  const timeEl = el.querySelector('time')

  const commentsHref = commentsA.href
  const permalink = new URL(commentsHref).pathname

  posts.push({
    id: el.getAttribute('data-fullname'),
    type: 'post',
    title: titleA.textContent.trim(),
    body: '',
    author: authorA ? authorA.textContent.trim() : null,
    subreddit: subA ? subA.textContent.trim() : null,
    score: scoreEl ? parseCount(scoreEl.textContent) : null,
    numComments: commentsA ? parseCount(commentsA.textContent) : 0,
    createdAt: timeEl ? timeEl.getAttribute('datetime') : null,
    permalink,
    url: commentsHref,
  })
})

const query = new URLSearchParams(location.search).get('q') || ''

console.log('[scraper] search content script ran:', posts.length, 'posts scraped for', query)

chrome.runtime.sendMessage({ type: 'SEARCH_RESULTS', query, posts }, () => {
  if (chrome.runtime.lastError) {
    console.error('[scraper] sendMessage failed:', chrome.runtime.lastError.message)
  }
})
