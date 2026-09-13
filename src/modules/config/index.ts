import 'server-only'

import {
  parseAuthConfig,
  parseDatabaseConfig,
  parseDeepSeekConfig,
  parseOperatorConfig,
  parseTelegramConfig,
} from './env'

export const loadDatabaseConfig = () => parseDatabaseConfig(process.env)
export const loadTelegramConfig = () => parseTelegramConfig(process.env)
export const loadDeepSeekConfig = () => parseDeepSeekConfig(process.env)
export const loadAuthConfig = () => parseAuthConfig(process.env)
export const loadOperatorConfig = () => parseOperatorConfig(process.env)
