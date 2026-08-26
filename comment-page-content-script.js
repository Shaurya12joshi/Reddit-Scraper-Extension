function parseScore(entry) {
  const scoreEl = entry ? entry.querySelector('.score.unvoted') : null
  if (!scoreEl) return null
  const titleAttr = scoreEl.getAttribute('title')
  if (titleAttr && /^\d+$/.test(titleAttr)) return parseInt(titleAttr, 10)
  const match = scoreEl.textContent.replace(/,/g, '').match(/\d+/)
  return match ? parseInt(match[0], 10) : null
}

const subreddit = location.pathname.split('/')[2] || null

const opThing = document.querySelector('.thing.link')
const selftextEl = opThing ? opThing.querySelector('.usertext-body .md') : null
const body = selftextEl ? selftextEl.textContent.trim() : ''

const MAX_COMMENTS = 8
const comments = []

document.querySelectorAll('.thing.comment').forEach((el) => {
  if (comments.length >= MAX_COMMENTS) return

  const entry = el.querySelector(':scope > .entry')
  const bodyEl = entry ? entry.querySelector(':scope .usertext-body .md') : null
  const text = bodyEl ? bodyEl.textContent.trim() : ''
  if (!text) return

  const author = el.getAttribute('data-author')
  const permalink = el.getAttribute('data-permalink')
  const timeEl = entry ? entry.querySelector('time') : null

  comments.push({
    id: el.getAttribute('data-fullname'),
    type: 'comment',
    title: '',
    body: text,
    author: author || '[deleted]',
    subreddit,
    score: parseScore(entry),
    numComments: 0,
    createdAt: timeEl ? timeEl.getAttribute('datetime') : null,
    permalink,
    url: permalink ? `https://old.reddit.com${permalink}` : null,
  })
})

console.log('[scraper] comment page content script ran —', comments.length, 'comments, body length', body.length)

chrome.runtime.sendMessage(
  {
    type: 'DETAIL_RESULT',
    permalink: location.pathname,
    body,
    comments,
  },
  () => {
    if (chrome.runtime.lastError) {
      console.error('[scraper] sendMessage failed:', chrome.runtime.lastError.message)
    }
  },
)
