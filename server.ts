#!/usr/bin/env bun
/**
 * inter-claude — a peer-to-peer channel that lets Claude Code sessions talk.
 *
 * Every session launches this file as a channel (an MCP server that pushes
 * events into the session). Sessions discover each other through a shared
 * directory and drop messages into each other's inbox; each server watches its
 * own inbox and pushes new messages straight into its session as <channel>
 * events. No daemon and no network — the filesystem is the bus.
 *
 *   bus root:  ~/.claude/channels/inter-claude
 *     peers/<name>.json        presence + heartbeat (discovery)
 *     inbox/<name>/<id>.json   messages waiting for <name>
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, watch,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// --- Config -----------------------------------------------------------------

const ROOT =
  process.env.INTER_CLAUDE_HOME ??
  join(homedir(), '.claude', 'channels', 'inter-claude')
const PEERS_DIR = join(ROOT, 'peers')
const INBOX_ROOT = join(ROOT, 'inbox')

const HEARTBEAT_MS = 15_000 // how often we refresh our presence
const STALE_MS = 45_000 // a peer silent this long is treated as offline
const POLL_MS = 3_000 // fallback sweep, in case an fs.watch event is missed

const sanitize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

let name =
  sanitize(process.env.INTER_CLAUDE_NAME ?? '') ||
  `claude-${Math.random().toString(36).slice(2, 6)}`

const inboxOf = (peer: string) => join(INBOX_ROOT, peer)

// --- Registry: presence & discovery -----------------------------------------

type Peer = { name: string; pid: number; startedAt: number; lastSeen: number }

function register(): void {
  mkdirSync(PEERS_DIR, { recursive: true })
  mkdirSync(inboxOf(name), { recursive: true })
  const peer: Peer = { name, pid: process.pid, startedAt: Date.now(), lastSeen: Date.now() }
  writeFileSync(join(PEERS_DIR, `${name}.json`), JSON.stringify(peer))
}

function heartbeat(): void {
  try {
    const f = join(PEERS_DIR, `${name}.json`)
    const peer: Peer = JSON.parse(readFileSync(f, 'utf8'))
    peer.lastSeen = Date.now()
    writeFileSync(f, JSON.stringify(peer))
  } catch {
    register() // presence file vanished — recreate it
  }
}

function unregister(peer = name): void {
  try { rmSync(join(PEERS_DIR, `${peer}.json`)) } catch {}
}

function listPeers(): Peer[] {
  if (!existsSync(PEERS_DIR)) return []
  const now = Date.now()
  const peers: Peer[] = []
  for (const f of readdirSync(PEERS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const p: Peer = JSON.parse(readFileSync(join(PEERS_DIR, f), 'utf8'))
      if (now - p.lastSeen > STALE_MS) {
        unregister(p.name) // reap stale presence
        continue
      }
      peers.push(p)
    } catch {}
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name))
}

const isLive = (peer: string) => listPeers().some(p => p.name === peer)

// --- Bus: outbound messages --------------------------------------------------

type Message = { id: string; from: string; text: string; ts: number }

let seq = 0
const nextId = () => `${Date.now()}-${++seq}`

function send(to: string, text: string): Message {
  if (to === name) throw new Error('cannot send to self')
  if (!isLive(to)) throw new Error(`no live peer named "${to}" (try list_peers)`)
  const msg: Message = { id: nextId(), from: name, text, ts: Date.now() }
  mkdirSync(inboxOf(to), { recursive: true })
  writeFileSync(join(inboxOf(to), `${msg.id}.json`), JSON.stringify(msg))
  return msg
}

// --- MCP server + tools ------------------------------------------------------

const mcp = new Server(
  { name: 'inter-claude', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'You are connected to other Claude Code sessions over the "inter-claude" channel. ' +
      'Their messages arrive as <channel source="inter-claude" from="<peer>" msg_id="...">text</channel>. ' +
      'To answer one, call send_message with `to` set to that `from` value. ' +
      'Other tools: list_peers (who is online), whoami (your own name), broadcast (message everyone), set_name (rename yourself).',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to one peer session by name.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target peer name (see list_peers)' },
          text: { type: 'string', description: 'Message body' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'broadcast',
      description: 'Send a message to every other online peer.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'list_peers',
      description: 'List Claude Code sessions currently online on this machine.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'whoami',
      description: "Show this session's peer name.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_name',
      description: 'Rename this session so peers can address it differently.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  ],
}))

const ok = (text: string) => ({ content: [{ type: 'text', text }] })

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send_message': {
        const m = send(String(args.to), String(args.text))
        return ok(`sent to ${args.to} (${m.id})`)
      }
      case 'broadcast': {
        const text = String(args.text)
        const targets = listPeers().filter(p => p.name !== name)
        for (const p of targets) send(p.name, text)
        return ok(`broadcast to ${targets.length} peer(s): ${targets.map(p => p.name).join(', ') || '(none)'}`)
      }
      case 'list_peers': {
        const peers = listPeers()
        const lines = peers.map(p => `${p.name === name ? '*' : ' '} ${p.name}${p.name === name ? ' (you)' : ''}`)
        return ok(peers.length ? `online peers:\n${lines.join('\n')}` : 'no peers online')
      }
      case 'whoami':
        return ok(name)
      case 'set_name': {
        const next = sanitize(String(args.name))
        if (!next) throw new Error('name must contain a-z, 0-9, _ or -')
        if (next === name) return ok(`already named ${name}`)
        if (isLive(next)) throw new Error(`name "${next}" is taken`)
        rename(next)
        return ok(`renamed to ${name}`)
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// --- Inbound delivery: watch our inbox, push into the session ----------------

function deliver(msg: Message): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msg.text,
      meta: { from: msg.from, msg_id: msg.id, ts: new Date(msg.ts).toISOString() },
    },
  })
}

function drain(): void {
  const dir = inboxOf(name)
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const path = join(dir, f)
    try { deliver(JSON.parse(readFileSync(path, 'utf8'))) } catch {}
    try { rmSync(path) } catch {}
  }
}

let watcher: ReturnType<typeof watch> | undefined
function watchInbox(): void {
  watcher?.close()
  mkdirSync(inboxOf(name), { recursive: true })
  watcher = watch(inboxOf(name), () => drain())
}

function rename(next: string): void {
  drain() // flush anything addressed to the old name first
  unregister(name)
  name = next
  register()
  watchInbox()
  drain()
}

// --- Lifecycle ---------------------------------------------------------------

register()
watchInbox()
drain() // deliver anything queued while we were offline (mailbox semantics)

const beat = setInterval(heartbeat, HEARTBEAT_MS)
const poll = setInterval(drain, POLL_MS)

function shutdown(): void {
  clearInterval(beat)
  clearInterval(poll)
  watcher?.close()
  unregister(name)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => unregister(name))
