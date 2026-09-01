// LEGACY — see legacy/config.js. Same role as background/errors.js: two
// "stop cleanly" error types that reddit-client.js throws and run-scrape.js
// catches via isStopSignal() to end a phase without crashing the run.
export class BudgetExhausted extends Error {
  constructor() {
    super('Reached this run\'s Reddit request budget.')
    this.name = 'BudgetExhausted'
  }
}

export class RateLimited extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimited'
  }
}

export const isStopSignal = (error) => error instanceof BudgetExhausted || error instanceof RateLimited
