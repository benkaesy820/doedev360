import pino from 'pino'
import { env } from './env.js'

export const logger = pino({
    level: env.isDev ? 'debug' : 'info',
    ...(env.isDev ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {})
})
