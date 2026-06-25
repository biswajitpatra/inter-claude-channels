#!/usr/bin/env bun
/**
 * agentbus — the module manager.
 *
 * agentbus is daemonless: the SQLite bus IS the central place, and a "module" is
 * a runtime adapter (a Delivery + a Trigger) described by adapters/<id>/module.json.
 * This CLI installs/enables/disables those modules and inspects the bus.
 *
 *   agentbus list                 modules and whether each is enabled
 *   agentbus enable <id>          wire the module into its runtime
 *   agentbus disable <id>         unwire it
 *   agentbus launch <id> [name]   print the command to start a session
 *   agentbus doctor               diagnose runtime, registration, peers, mailboxes
 *   agentbus uninstall            disable every module + remove the bus
 */
import { Database } from 'bun:sqlite'
import {
  readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { styleText } from 'node:util'
import { DB_PATH, WAKE_DIR, HOME } from './core/paths'

const REPO = import.meta.dir
const ADAPTERS = join(REPO, 'adapters')
const CLAUDE_JSON = join(homedir(), '.claude.json')

type Module = {
  id: string
  title: string
  runtime: string
  delivery: string
  trigger: string
  entry: string
  register: { kind: string; name: string }
  launch: string
}

const C = {
  dim: (s: string) => styleText('dim', s),
  bold: (s: string) => styleText('bold', s),
  green: (s: string) => styleText('green', s),
  red: (s: string) => styleText('red', s),
  cyan: (s: string) => styleText('cyan', s),
}

function modules(): Module[] {
  if (!existsSync(ADAPTERS)) return []
  return readdirSync(ADAPTERS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(ADAPTERS, d.name, 'module.json'))
    .filter(existsSync)
    .map(p => JSON.parse(readFileSync(p, 'utf8')) as Module)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function getModule(id: string): Module {
  const m = modules().find(x => x.id === id)
  if (!m) { console.error(C.red(`unknown module "${id}"`)); console.error('run: agentbus list'); process.exit(1) }
  return m
}

// --- Claude MCP registration (the only register kind today) ------------------

function readClaudeJson(): any {
  return existsSync(CLAUDE_JSON) ? JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) : {}
}
function writeClaudeJson(d: any): void {
  if (existsSync(CLAUDE_JSON)) copyFileSync(CLAUDE_JSON, `${CLAUDE_JSON}.bak-agentbus`)
  writeFileSync(CLAUDE_JSON, JSON.stringify(d, null, 2))
}
function isEnabled(m: Module): boolean {
  return Boolean(readClaudeJson().mcpServers?.[m.register.name])
}

function enable(m: Module): void {
  if (m.register.kind !== 'claude-mcp-server') {
    console.error(C.red(`don't know how to register kind "${m.register.kind}" yet`)); process.exit(1)
  }
  const d = readClaudeJson()
  ;(d.mcpServers ??= {})[m.register.name] = { command: 'bun', args: [join(REPO, m.entry)] }
  writeClaudeJson(d)
  console.log(C.green(`✓ enabled ${m.id}`) + C.dim(` (MCP server "${m.register.name}" in ~/.claude.json)`))
  console.log(`\nlaunch a session with:\n  ${C.cyan(m.launch)}`)
}

function disable(m: Module): void {
  const d = readClaudeJson()
  const had = d.mcpServers && m.register.name in d.mcpServers
  if (had) { delete d.mcpServers[m.register.name]; writeClaudeJson(d) }
  console.log(had ? C.green(`✓ disabled ${m.id}`) : C.dim(`- ${m.id} was not enabled`))
}

// --- commands ----------------------------------------------------------------

function cmdList(): void {
  const ms = modules()
  if (!ms.length) { console.log('no modules found under adapters/'); return }
  console.log(C.bold('agentbus modules\n'))
  for (const m of ms) {
    const on = isEnabled(m)
    console.log(`  ${on ? C.green('●') : C.dim('○')} ${C.bold(m.id)}${C.dim(` — ${m.title}`)}`)
    console.log(C.dim(`      runtime=${m.runtime}  delivery=${m.delivery}  trigger=${m.trigger}  ${on ? 'enabled' : 'disabled'}`))
  }
  console.log(C.dim('\n  ● enabled   ○ disabled    enable: agentbus enable <id>'))
}

function cmdLaunch(id: string, name?: string): void {
  const m = getModule(id)
  const cmd = name ? m.launch.replace('<name>', name) : m.launch
  console.log(cmd)
}

function cmdDoctor(): void {
  const line = (okState: boolean, s: string) => console.log(`  ${okState ? C.green('✔') : C.red('✗')} ${s}`)
  console.log(C.bold('agentbus doctor') + C.dim(`  (home: ${HOME})`) + '\n')

  line(Boolean(Bun.which('bun')), `bun ${Bun.version}`)
  line(Boolean(Bun.which('claude')), 'claude CLI on PATH  (channels need >= 2.1.80)')

  console.log('\n' + C.bold('modules'))
  for (const m of modules()) line(isEnabled(m), `${m.id} ${isEnabled(m) ? 'enabled' : C.dim('disabled')}`)

  console.log('\n' + C.bold('bus') + C.dim(`  ${DB_PATH}`))
  if (!existsSync(DB_PATH)) { console.log(C.dim('  (no bus yet — start a session first)')); return }
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const now = Date.now()
    const peers = db.query('SELECT name, pid, last_seen FROM peers ORDER BY name').all() as any[]
    console.log('  live peers:')
    if (!peers.length) console.log(C.dim('    (none)'))
    for (const p of peers) {
      const state = p.last_seen >= now - 45_000 ? C.green('online') : C.dim('stale')
      console.log(`    - ${p.name} (pid ${p.pid})  ${state}`)
    }
    const box = db.query(
      'SELECT recipient, sum(delivered_at IS NULL) pending, sum(delivered_at IS NOT NULL) delivered FROM messages GROUP BY recipient ORDER BY recipient',
    ).all() as any[]
    console.log('  mailboxes (pending / delivered):')
    if (!box.length) console.log(C.dim('    (no messages yet)'))
    for (const b of box) console.log(`    - ${b.recipient}  ${b.pending} pending / ${b.delivered} delivered`)
  } finally { db.close() }
}

function cmdUninstall(): void {
  for (const m of modules()) disable(m)
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, `${DB_PATH}.init.lock`]) {
    try { rmSync(f) } catch {}
  }
  try { rmSync(WAKE_DIR, { recursive: true, force: true }) } catch {}
  try { rmSync(HOME, { recursive: false }) } catch {} // only if now empty
  console.log(C.green('\n✓ uninstalled') + C.dim(' — restart any running session to drop the loaded channel.'))
}

function usage(): void {
  console.log(`agentbus — local message bus for AI agent sessions

usage:
  agentbus list                 modules and whether each is enabled
  agentbus enable <id>          wire a module into its runtime
  agentbus disable <id>         unwire it
  agentbus launch <id> [name]   print the command to start a session
  agentbus doctor               diagnose runtime, registration, peers, mailboxes
  agentbus uninstall            disable every module + remove the bus`)
}

const [cmd, a1, a2] = process.argv.slice(2)
switch (cmd) {
  case 'list': cmdList(); break
  case 'enable': enable(getModule(a1)); break
  case 'disable': disable(getModule(a1)); break
  case 'launch': cmdLaunch(a1, a2); break
  case 'doctor': cmdDoctor(); break
  case 'uninstall': cmdUninstall(); break
  default: usage(); if (cmd) process.exit(1)
}
