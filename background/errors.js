// Two special error types used to tell "the run should stop cleanly, nothing
// is broken" apart from a real bug. reddit-client.js throws these instead of
// a plain Error; run-scrape.js and run-field-scan.js catch them with
// isStopSignal() to end a phase gracefully (keep what was collected so far)
// rather than letting the whole run crash.

// Thrown once a run has spent its RUN_READ_BUDGET (config.js) worth of
// Reddit requests. Not a failure — just "we've read enough, wrap up."
export class BudgetExhausted extends Error {
  constructor(message) {
    super(message || 'Reached this run\'s Reddit request budget.')
    this.name = 'BudgetExhausted'
  }
}

// Thrown when Reddit itself is refusing requests (429/503, or we've
// pre-emptively locked ourselves out — see rate-limiter.js lockOut).
export class RateLimited extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimited'
  }
}

// True for either "stop signal" error — the two cases every optional-fetch
// and run-loop catch block needs to treat the same way (bail out quietly,
// keep collected data, don't log it as a crash).
export const isStopSignal = (error) => error instanceof BudgetExhausted || error instanceof RateLimited
