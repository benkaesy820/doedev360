import { logger } from './logger.js'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  failureThreshold: number
  recoveryTimeoutMs: number
  name: string
  onStateChange?: (state: CircuitState, failures: number) => void
}

export class CircuitBreaker {
  private failures = 0
  private lastFailureTime = 0
  private state: CircuitState = 'CLOSED'
  private config: CircuitBreakerConfig
  private transitionLock = false

  constructor(config: CircuitBreakerConfig) {
    this.config = config
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.config.recoveryTimeoutMs) {
        if (!this.transitionLock) {
          this.transitionLock = true
          this.transitionTo('HALF_OPEN')
          this.transitionLock = false
        }
      }
      if (this.state === 'OPEN') {
        throw new Error(`${this.config.name} circuit breaker is OPEN - service temporarily unavailable`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess(): void {
    if (this.state !== 'CLOSED') {
      this.transitionTo('CLOSED')
    }
    this.failures = 0
  }

  private onFailure(): void {
    this.failures++
    this.lastFailureTime = Date.now()
    if (this.failures >= this.config.failureThreshold) {
      this.transitionTo('OPEN')
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state
    this.state = newState
    logger.info({ 
      name: this.config.name, 
      oldState, 
      newState, 
      failures: this.failures 
    }, `Circuit breaker state changed`)
    this.config.onStateChange?.(newState, this.failures)
  }

  getState(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.failures }
  }

  reset(): void {
    this.failures = 0
    this.state = 'CLOSED'
    this.lastFailureTime = 0
  }
}
