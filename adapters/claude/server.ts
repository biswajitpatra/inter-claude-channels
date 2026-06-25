#!/usr/bin/env bun
/**
 * claude / channel mode — the push delivery for Claude Code (agentbus).
 *
 * Launches as a channel (an MCP server that pushes events into the session) and
 * wires the runtime-agnostic core to two ports:
 *   - Delivery: an MCP `notifications/claude/channel` push (last-mile injection
 *     into the live session — the one thing A2A/HTTP can't do for a stdio REPL).
 *   - Trigger:  file-watch by default, or poll via AGENTBUS_TRIGGER=poll.
 *
 * Prior art: clauder (https://github.com/MaorBril/clauder) pioneered
 * cross-session messaging for Claude Code over a shared SQLite store; agentbus
 * keeps the store but delivers through the native channels API and splits the
 * transport into pluggable ports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openBus } from '../../core/bus'
import { DB_PATH, WAKE_DIR } from '../../core/paths'
import type { Delivery, Trigger } from '../../core/ports'
import { fileWatchTrigger } from '../../triggers/file-watch'
import { pollTrigger } from '../../triggers/poll'

// --- Config -----------------------------------------------------------------

const HEARTBEAT_MS = 15_000 // how often we refresh our presence
const STALE_MS = 45_000 // a peer silent this long is treated as offline
const POLL_MS = 3_000 // safety-net poll; the primary trigger is the wake-file watch
const PRUNE_MS = 60_000 // how often to drop old delivered messages
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000 // keep delivered rows this long

const sanitize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

let name =
  sanitize(process.env.AGENTBUS_NAME ?? '') ||
  `agent-${Math.random().toString(36).slice(2, 6)}`

const bus = openBus(DB_PATH)

// Trigger port (PULL): file-watch by default; AGENTBUS_TRIGGER=poll to swap.
const trigger: Trigger =
  process.env.AGENTBUS_TRIGGER === 'poll' ? pollTrigger(POLL_MS) : fileWatchTrigger(WAKE_DIR)

// --- Registry / send (thin wrappers over the bus) ---------------------------

const register = () => bus.registerPeer(name, process.pid)
const listPeers = () => bus.livePeers(STALE_MS)
const isLive = (peer: string) => bus.isLive(peer, STALE_MS)

function send(to: string, text: string): number {
  if (to === name) throw new Error('cannot send to self')
  if (!isLive(to)) throw new Error(`no live peer named "${to}" (try list_peers)`)
  const id = bus.enqueue(name, to, text)
  trigger.notify(to) // nudge the recipient to drain now
  return id
}

// --- MCP server + tools ------------------------------------------------------

const mcp = new McpServer(
  { name: 'agentbus', version: '0.2.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'You are connected to other agent sessions over the "agentbus" channel. ' +
      'Their messages arrive as <channel source="agentbus" from="<peer>" msg_id="...">text</channel>. ' +
      'To answer one, call send_message with `to` set to that `from` value. ' +
      'Other tools: list_peers (who is online), whoami (your own name), broadcast (message everyone), set_name (rename yourself).',
  },
)

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

mcp.registerTool('send_message',
  { description: 'Send a message to one peer session by name.', inputSchema: { to: z.string(), text: z.string() } },
  async ({ to, text }) => ok(`sent to ${to} (#${send(to, text)})`),
)

mcp.registerTool('broadcast',
  { description: 'Send a message to every other online peer.', inputSchema: { text: z.string() } },
  async ({ text }) => {
    const targets = listPeers().filter(p => p.name !== name)
    for (const p of targets) send(p.name, text)
    return ok(`broadcast to ${targets.length} peer(s): ${targets.map(p => p.name).join(', ') || '(none)'}`)
  },
)

mcp.registerTool('list_peers',
  { description: 'List agent sessions currently online on this machine.', inputSchema: {} },
  async () => {
    const peers = listPeers()
    const lines = peers.map(p => `${p.name === name ? '*' : ' '} ${p.name}${p.name === name ? ' (you)' : ''}`)
    return ok(peers.length ? `online peers:\n${lines.join('\n')}` : 'no peers online')
  },
)

mcp.registerTool('whoami',
  { description: "Show this session's peer name.", inputSchema: {} },
  async () => ok(name),
)

mcp.registerTool('set_name',
  { description: 'Rename this session so peers can address it differently.', inputSchema: { name: z.string() } },
  async ({ name: raw }) => {
    const next = sanitize(raw)
    if (!next) throw new Error('name must contain a-z, 0-9, _ or -')
    if (next === name) return ok(`already named ${name}`)
    if (isLive(next)) throw new Error(`name "${next}" is taken`)
    rename(next)
    return ok(`renamed to ${name}`)
  },
)

await mcp.connect(new StdioServerTransport())

// --- Delivery port (PUSH): inject a message into THIS live session -----------

const delivery: Delivery = {
  async deliver(env) {
    await mcp.server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: env.body,
        meta: { from: env.from, msg_id: String(env.id), ts: new Date(env.createdAt).toISOString() },
      },
    })
  },
}

// --- Inbound: drain our pending rows, push, stamp delivered ------------------

let closed = false
let draining = false

async function drain(): Promise<void> {
  if (closed || draining) return
  draining = true
  try {
    for (const m of bus.pending(name)) {
      if (closed) return
      try {
        await delivery.deliver({ id: m.id, from: m.sender, to: m.recipient, body: m.body, createdAt: m.createdAt })
      } catch {
        return // transport gone — leave the row pending, deliver it next time
      }
      bus.markDelivered(m.id) // mark "gone" only after a successful push
    }
  } finally {
    draining = false
  }
}

// the Trigger is the primary wake; rebind it whenever our name changes
let disposeTrigger: (() => void) | undefined
function arm(): void {
  disposeTrigger?.()
  disposeTrigger = trigger.arm(name, () => void drain())
}

function rename(next: string): void {
  bus.reassignPending(name, next) // move pending rows to the new name
  bus.unregisterPeer(name)
  name = next
  register()
  arm() // re-point the trigger at the new name
  void drain()
}

// --- Lifecycle ---------------------------------------------------------------

register()
arm() // drain the instant a peer nudges us
void drain() // deliver anything queued while we were offline (mailbox semantics)
bus.prune(DELIVERED_TTL_MS)

const beat = setInterval(() => bus.heartbeat(name, process.pid), HEARTBEAT_MS)
const poll = setInterval(drain, POLL_MS) // safety net for any missed wake event
const pruner = setInterval(() => { if (!closed) bus.prune(DELIVERED_TTL_MS) }, PRUNE_MS)

function shutdown(): void {
  if (closed) return
  closed = true
  clearInterval(beat)
  clearInterval(poll)
  clearInterval(pruner)
  disposeTrigger?.()
  try { bus.unregisterPeer(name) } catch {}
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.server.onclose = shutdown // parent disconnected (stdin EOF) — stop cleanly
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (!closed) { try { bus.unregisterPeer(name) } catch {} } })
