/**
 * Integration test: spawn two real server processes over stdio and verify
 * discovery, cross-session delivery, offline queueing, and rename.
 */
import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const text = (r: any) => JSON.stringify(r)

function session(name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['server.ts'],
    env: { ...process.env, INTER_CLAUDE_NAME: name, INTER_CLAUDE_HOME: home },
  })
  const client = new Client({ name: `test-${name}`, version: '0' })
  return { client, transport }
}

test('discovery + delivery + rename', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inter-claude-'))
  const received: unknown[] = []

  const alice = session('alice', home)
  const bob = session('bob', home)
  bob.client.fallbackNotificationHandler = async n => void received.push(n)

  await Promise.all([
    alice.client.connect(alice.transport),
    bob.client.connect(bob.transport),
  ])
  await Bun.sleep(400) // let both register their presence

  // discovery
  const peers = await alice.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers)).toContain('bob')

  // delivery: alice -> bob, pushed as a channel notification
  await alice.client.callTool({ name: 'send_message', arguments: { to: 'bob', text: 'ping-123' } })
  await Bun.sleep(500)
  expect(text(received)).toContain('notifications/claude/channel')
  expect(text(received)).toContain('ping-123')
  expect(text(received)).toContain('alice') // from attribute

  // rename: alice -> apiserver, bob can reach the new name
  await alice.client.callTool({ name: 'set_name', arguments: { name: 'apiserver' } })
  await Bun.sleep(200)
  const peers2 = await bob.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers2)).toContain('apiserver')

  await alice.client.close()
  await bob.client.close()
}, 20_000)

test('offline queue drains on startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inter-claude-'))
  const received: unknown[] = []

  // drop a message into carol's inbox before carol exists
  mkdirSync(join(home, 'inbox', 'carol'), { recursive: true })
  writeFileSync(
    join(home, 'inbox', 'carol', '1-1.json'),
    JSON.stringify({ id: '1-1', from: 'dave', text: 'queued-while-offline', ts: Date.now() }),
  )

  const carol = session('carol', home)
  carol.client.fallbackNotificationHandler = async n => void received.push(n)
  await carol.client.connect(carol.transport)
  await Bun.sleep(500)

  expect(text(received)).toContain('queued-while-offline')
  await carol.client.close()
}, 20_000)
