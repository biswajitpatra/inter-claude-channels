/**
 * Where the bus lives. Runtime-agnostic: the store is not under any one agent's
 * config dir. Override the whole tree with AGENTBUS_HOME (used by tests).
 */
import { homedir } from 'os'
import { join } from 'path'

export const HOME = process.env.AGENTBUS_HOME ?? join(homedir(), '.agentbus')
export const DB_PATH = join(HOME, 'bus.db')
export const WAKE_DIR = join(HOME, 'wake')
