#!/usr/bin/env bun
/**
 * agentbus — the module manager.
 *
 * agentbus is daemonless: the SQLite bus IS the central place. A "module" is a
 * runtime (described by adapters/<id>/module.json); each module offers one or
 * more delivery **modes** — how messages reach a session. Modes can stack, and
 * modules are independent. The Claude Code module offers:
 *   - channel: push, real-time (file-watch/poll + MCP channel)
 *   - hook:    pull, turn-boundary (Claude Code Stop/SessionStart hooks)
 * This CLI enables/disables those modes and inspects the bus.
 *
 *   agentbus list                    modules, modes, and which is active
 *   agentbus enable <id> [mode]      enable a delivery mode (omit=default, "all"=every)
 *   agentbus disable <id>            turn a module off
 *   agentbus launch <id> [name]      print the command to start a session
 *   agentbus doctor                  diagnose runtime, registration, peers, mailboxes
 *   agentbus uninstall               disable every module + remove the bus
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { styleText } from 'node:util'
import { DB_PATH, WAKE_DIR, HOME } from './core/paths'

const REPO = import.meta.dir
const ADAPTERS = join(REPO, 'adapters')
const CLAUDE_JSON = join(homedir(), '.claude.json')
const SETTINGS_JSON = join(homedir(), '.claude', 'settings.json')

type Register = { kind: string; name?: string; events?: string[] }
type Mode = { title: string; delivery: string; trigger: string; entry: string; register: Register; launch: string }
type Module = { id: string; title: string; runtime: string; defaultMode: string; modes: Record<string, Mode> }

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

// --- JSON config helpers -----------------------------------------------------

function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
function writeJson(path: string, d: any): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-agentbus`)
  writeFileSync(path, JSON.stringify(d, null, 2))
}
const hookCommand = (mode: Mode) => `bun ${join(REPO, mode.entry)}`

// --- per-mode registration (dispatch by register.kind) -----------------------

function isModeEnabled(mode: Mode): boolean {
  if (mode.register.kind === 'claude-mcp-server') {
    return Boolean(readJson(CLAUDE_JSON).mcpServers?.[mode.register.name!])
  }
  if (mode.register.kind === 'claude-hook') {
    const cmd = hookCommand(mode)
    const hooks = readJson(SETTINGS_JSON).hooks ?? {}
    return Object.values(hooks).some((arr: any) =>
      (arr as any[]).some(g => (g.hooks ?? []).some((h: any) => h.command === cmd)))
  }
  return false
}

function registerMode(mode: Mode): void {
  if (mode.register.kind === 'claude-mcp-server') {
    const d = readJson(CLAUDE_JSON)
    ;(d.mcpServers ??= {})[mode.register.name!] = { command: 'bun', args: [join(REPO, mode.entry)] }
    writeJson(CLAUDE_JSON, d)
  } else if (mode.register.kind === 'claude-hook') {
    const d = readJson(SETTINGS_JSON)
    const cmd = hookCommand(mode)
    d.hooks ??= {}
    for (const ev of mode.register.events ?? []) {
      d.hooks[ev] ??= []
      const present = (d.hooks[ev] as any[]).some(g => (g.hooks ?? []).some((h: any) => h.command === cmd))
      if (!present) d.hooks[ev].push({ hooks: [{ type: 'command', command: cmd }] })
    }
    writeJson(SETTINGS_JSON, d)
  } else {
    console.error(C.red(`don't know how to register kind "${mode.register.kind}" yet`)); process.exit(1)
  }
}

function unregisterMode(mode: Mode): boolean {
  if (mode.register.kind === 'claude-mcp-server') {
    const d = readJson(CLAUDE_JSON)
    const had = Boolean(d.mcpServers && mode.register.name! in d.mcpServers)
    if (had) { delete d.mcpServers[mode.register.name!]; writeJson(CLAUDE_JSON, d) }
    return had
  }
  if (mode.register.kind === 'claude-hook') {
    const d = readJson(SETTINGS_JSON)
    const cmd = hookCommand(mode)
    let had = false
    for (const ev of Object.keys(d.hooks ?? {})) {
      const before = (d.hooks[ev] as any[]).length
      d.hooks[ev] = (d.hooks[ev] as any[]).filter(g => !(g.hooks ?? []).some((h: any) => h.command === cmd))
      if (d.hooks[ev].length !== before) had = true
      if (!d.hooks[ev].length) delete d.hooks[ev]
    }
    if (had) writeJson(SETTINGS_JSON, d)
    return had
  }
  return false
}

/** The currently-enabled mode ids for a module (may be several, or none). */
function activeModes(m: Module): string[] {
  return Object.entries(m.modes).filter(([, mode]) => isModeEnabled(mode)).map(([id]) => id)
}

const whereOf = (mode: Mode) =>
  mode.register.kind === 'claude-hook'
    ? `${(mode.register.events ?? []).join('/')} hooks in ~/.claude/settings.json`
    : `MCP server "${mode.register.name}" in ~/.claude.json`

// --- commands ----------------------------------------------------------------

// Modes are NOT mutually exclusive: enable any subset. They cooperate through the
// bus — whichever mechanism drains a pending row first delivers it; the others
// find it already gone. "all" enables every mode; omitting the mode uses default.
function enable(m: Module, modeId?: string): void {
  const ids = modeId === 'all' ? Object.keys(m.modes) : [modeId ?? m.defaultMode]
  for (const id of ids) {
    const mode = m.modes[id]
    if (!mode) {
      console.error(C.red(`unknown mode "${id}" for ${m.id}`))
      console.error(`modes: ${Object.keys(m.modes).join(', ')}, or "all"`); process.exit(1)
    }
    registerMode(mode)
    console.log(C.green(`✓ ${m.id} → ${id} enabled`) + C.dim(` (${whereOf(mode)})`))
    console.log(C.dim('  launch: ') + C.cyan(mode.launch))
  }
  if (activeModes(m).length > 1)
    console.log(C.dim('\n  multiple modes active — whichever drains a message first delivers it.'))
}

function disable(m: Module, modeId?: string): void {
  const ids = modeId && modeId !== 'all' ? [modeId] : Object.keys(m.modes)
  let had = false
  for (const id of ids) { const mode = m.modes[id]; if (mode) had = unregisterMode(mode) || had }
  const scope = modeId && modeId !== 'all' ? ` (${modeId})` : ''
  console.log(had ? C.green(`✓ disabled ${m.id}${scope}`) : C.dim(`- ${m.id}${scope} was not enabled`))
}

function cmdList(): void {
  const ms = modules()
  if (!ms.length) { console.log('no modules found under adapters/'); return }
  console.log(C.bold('agentbus modules\n'))
  for (const m of ms) {
    const active = activeModes(m)
    console.log(`  ${active.length ? C.green('●') : C.dim('○')} ${C.bold(m.id)}${C.dim(` — ${m.title}  [runtime: ${m.runtime}]`)}`)
    for (const [id, mode] of Object.entries(m.modes)) {
      const on = active.includes(id)
      console.log(`      ${on ? C.green('▸') : C.dim('·')} ${id}${C.dim(`  ${mode.title}`)}${on ? C.green('   ← on') : ''}`)
    }
  }
  console.log(C.dim('\n  enable: agentbus enable <id> [mode|all]   (modes can stack; modules are independent)'))
}

function cmdLaunch(id: string, name?: string): void {
  const m = getModule(id)
  const mode = m.modes[activeModes(m)[0] ?? m.defaultMode]
  console.log(name ? mode.launch.replace('<name>', name) : mode.launch)
}

function cmdDoctor(): void {
  const line = (okState: boolean, s: string) => console.log(`  ${okState ? C.green('✔') : C.red('✗')} ${s}`)
  console.log(C.bold('agentbus doctor') + C.dim(`  (home: ${HOME})`) + '\n')

  line(Boolean(Bun.which('bun')), `bun ${Bun.version}`)
  line(Boolean(Bun.which('claude')), 'claude CLI on PATH  (channels need >= 2.1.80)')

  console.log('\n' + C.bold('modules'))
  for (const m of modules()) {
    const active = activeModes(m)
    line(active.length > 0, `${m.id} ${active.length ? `→ ${active.join(', ')}` : C.dim('disabled')}`)
  }

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
  console.log(C.green('\n✓ uninstalled') + C.dim(' — restart any running session to drop the loaded channel/hook.'))
}

function usage(): void {
  console.log(`agentbus — local message bus for AI agent sessions

usage:
  agentbus list                  modules, modes, and which is active
  agentbus enable <id> [mode]    enable a delivery mode (omit=default, "all"=every mode)
  agentbus disable <id> [mode]   disable one mode, or the whole module
  agentbus launch <id> [name]    print the command to start a session
  agentbus doctor                diagnose runtime, registration, peers, mailboxes
  agentbus uninstall             disable every module + remove the bus`)
}

const [cmd, a1, a2] = process.argv.slice(2)
switch (cmd) {
  case 'list': cmdList(); break
  case 'enable': enable(getModule(a1), a2); break
  case 'disable': disable(getModule(a1), a2); break
  case 'launch': cmdLaunch(a1, a2); break
  case 'doctor': cmdDoctor(); break
  case 'uninstall': cmdUninstall(); break
  default: usage(); if (cmd) process.exit(1)
}
