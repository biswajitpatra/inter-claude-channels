/**
 * The bus: all shared state (peers + messages) in one SQLite database, accessed
 * through Drizzle. Pending migrations are applied on open, so a freshly shipped
 * schema change upgrades the store automatically.
 *
 * This module is runtime-agnostic: it knows nothing about MCP, channels, or how
 * a message reaches a session (that is the Delivery port) or how a recipient is
 * woken (that is the Trigger port). It is purely presence + a durable mailbox.
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { and, asc, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm'
import { mkdirSync, openSync, closeSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { messages, peers, type Message, type Peer } from './schema'

export type { Message, Peer }

// Serialize cross-process init (the WAL switch + migrations) on a fresh DB with
// an exclusive lock file, so concurrently-started sessions don't collide.
function withInitLock(dbPath: string, fn: () => void): void {
  const lock = `${dbPath}.init.lock`
  const start = Date.now()
  for (;;) {
    let fd: number
    try {
      fd = openSync(lock, 'wx') // O_CREAT|O_EXCL — fails if another process holds it
    } catch {
      if (Date.now() - start > 20_000) { try { rmSync(lock) } catch {} } // steal a stale lock
      Bun.sleepSync(25)
      continue
    }
    try { fn() } finally {
      try { closeSync(fd) } catch {}
      try { rmSync(lock) } catch {}
    }
    return
  }
}

export function openBus(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath, { create: true })
  sqlite.exec('PRAGMA busy_timeout = 10000;') // per-connection: wait on locks, don't fail
  const db = drizzle({ client: sqlite })

  // Only one process sets WAL + runs migrations at a time; the rest wait, then
  // find WAL already on and migrations already applied (both no-ops).
  withInitLock(dbPath, () => {
    sqlite.exec('PRAGMA journal_mode = WAL;')
    migrate(db, { migrationsFolder: join(import.meta.dir, '..', 'drizzle') })
  })

  const now = () => Date.now()

  return {
    // --- presence / discovery ---
    registerPeer(name: string, pid: number) {
      const t = now()
      db.insert(peers).values({ name, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: peers.name, set: { pid, startedAt: t, lastSeen: t } }).run()
    },
    heartbeat(name: string, pid: number) {
      const t = now()
      db.insert(peers).values({ name, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: peers.name, set: { lastSeen: t } }).run()
    },
    unregisterPeer(name: string) {
      db.delete(peers).where(eq(peers.name, name)).run()
    },
    livePeers(staleMs: number): Peer[] {
      const cut = now() - staleMs
      db.delete(peers).where(lt(peers.lastSeen, cut)).run() // reap silent peers
      return db.select().from(peers).where(gte(peers.lastSeen, cut)).orderBy(asc(peers.name)).all()
    },
    isLive(name: string, staleMs: number): boolean {
      return db.select().from(peers)
        .where(and(eq(peers.name, name), gte(peers.lastSeen, now() - staleMs))).get() != null
    },

    // --- messages (the durable mailbox) ---
    enqueue(sender: string, recipient: string, body: string): number {
      const [row] = db.insert(messages)
        .values({ sender, recipient, body, createdAt: now() })
        .returning({ id: messages.id }).all()
      return row.id
    },
    pending(recipient: string): Message[] {
      return db.select().from(messages)
        .where(and(eq(messages.recipient, recipient), isNull(messages.deliveredAt)))
        .orderBy(asc(messages.id)).all()
    },
    markDelivered(id: number) {
      db.update(messages).set({ deliveredAt: now() }).where(eq(messages.id, id)).run()
    },
    reassignPending(from: string, to: string) {
      db.update(messages).set({ recipient: to })
        .where(and(eq(messages.recipient, from), isNull(messages.deliveredAt))).run()
    },
    prune(ttlMs: number) {
      db.delete(messages)
        .where(and(isNotNull(messages.deliveredAt), lt(messages.deliveredAt, now() - ttlMs))).run()
    },

    close() {
      sqlite.close()
    },
  }
}

export type Bus = ReturnType<typeof openBus>
