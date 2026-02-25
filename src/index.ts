import { startServer } from './app.js'
import { logger } from './lib/logger.js'
import { env } from './lib/env.js'

async function main(): Promise<void> {
  try {
    await startServer()
    logger.info(`Server running in ${env.nodeEnv} mode on port ${env.port}`)
  } catch (error) {
    logger.fatal(error, 'Failed to start server')
    process.exit(1)
  }
}

main()
