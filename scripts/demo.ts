#!/usr/bin/env bun
/**
 * Self-driving demo of agentbus, used to record the README cast.
 *
 * It spawns two REAL adapter processes over stdio and drives them with the MCP
 * client — the same discovery, delivery, and rename the tools do in a live
 * session. Nothing here is faked; only the narration and pacing are scripted.
 *
 *   bun scripts/demo.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { styleText } from 'node:util'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dim = (s: string) => styleText('dim', s)
const cyan = (s: string) => styleText('cyan', s)
const green = (s: string) => styleText('green', s)
const yellow = (s: string) => styleText('yellow', s)
const bold = (s: string) => styleText('bold', s)

const sleep = (ms: number) => Bun.sleep(ms)
const say = async (s = '') => { console.log(s); await sleep(700) }
const text = (r: any) => r.content?.[0]?.text ?? JSON.stringify(r)

function session(name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['adapters/claude-mcp/server.ts'],
    env: { ...process.env, AGENTBUS_NAME: name, AGENTBUS_HOME: home },
  })
  return { client: new Client({ name: `demo-${name}`, version: '0' }), transport }
}

const home = mkdtempSync(join(tmpdir(), 'agentbus-demo-'))

await say(bold('agentbus') + dim(' — two agent sessions talking'))
await say()

await say(dim('$ ') + 'AGENTBUS_NAME=frontend claude --dangerously-load-development-channels server:agentbus')
await say(dim('$ ') + 'AGENTBUS_NAME=backend  claude --dangerously-load-development-channels server:agentbus')
const frontend = session('frontend', home)
const backend = session('backend', home)
const inbox: string[] = []
backend.client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === 'notifications/claude/channel') {
    const p = n.params
    inbox.push(`<channel source="agentbus" from="${p.meta.from}" msg_id="${p.meta.msg_id}">\n  ${p.content}\n</channel>`)
  }
}
await Promise.all([
  frontend.client.connect(frontend.transport),
  backend.client.connect(backend.transport),
])
await sleep(600)
await say(green('  ✓ both sessions online'))
await say()

await say(cyan('frontend ▸ ') + 'list_peers')
await say(dim(text(await frontend.client.callTool({ name: 'list_peers', arguments: {} })).split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(cyan('frontend ▸ ') + 'send_message  to=backend  text=' + yellow('"what\'s the shape of GET /users?"'))
await frontend.client.callTool({ name: 'send_message', arguments: { to: 'backend', text: "what's the shape of GET /users?" } })
await sleep(800)
await say(green('  ✓ pushed into backend\'s running session:'))
await say(dim(inbox[0]?.split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(cyan('backend ▸ ') + 'send_message  to=frontend  text=' + yellow('"{ id, name, email }"'))
await backend.client.callTool({ name: 'send_message', arguments: { to: 'frontend', text: '{ id, name, email }' } })
await sleep(600)
await say(green('  ✓ reply delivered'))
await say()

await say(cyan('backend ▸ ') + 'set_name  name=api')
await say(dim('  ' + text(await backend.client.callTool({ name: 'set_name', arguments: { name: 'api' } }))))
await sleep(400)
await say(cyan('frontend ▸ ') + 'list_peers')
await say(dim(text(await frontend.client.callTool({ name: 'list_peers', arguments: {} })).split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(green('  ✓ renamed live — no restart. ') + dim('github.com/biswajitpatra/agentbus'))

await frontend.client.close()
await backend.client.close()
process.exit(0)
