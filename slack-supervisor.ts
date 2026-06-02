#!/usr/bin/env -S npx tsx
/**
 * slack-supervisor — keeps the router and the Claude Code sessions alive.
 *
 * Reads a config describing the router + a list of sessions. On each tick it
 * checks liveness and respawns anything that died, with backoff. Sessions are
 * launched inside tmux (a persistent pty — a long-lived `claude` channel
 * session needs a terminal; tmux also matches the plugin's SLACK_TMUX_SESSION
 * admin integration). The router is a plain server, run as a direct child.
 *
 * Liveness is ground-truthed against the router's /health endpoint: a session
 * counts as healthy only when its tmux session exists AND it is registered and
 * live in the router. That confirms the whole chain (claude up → slack-session
 * MCP up → registered).
 *
 * Resume: each session gets a stable UUID. First launch uses --session-id; every
 * respawn uses --resume <uuid> so the conversation persists across crashes.
 *
 * Usage:
 *   npx tsx slack-supervisor.ts [up|down|status] [--config <path>] [--once]
 *     up      (default) supervise forever, respawning dead pieces
 *     down    stop the router child + kill session tmux windows, then exit
 *     status  print one health snapshot and exit
 *
 * Config default: ~/.claude/slack-router/supervisor.json  (see supervisor.example.json)
 *
 * NOTE: the exact `claude` channel-launch flags are a configurable template
 * (`launchTemplate`) because the channels flags are a Research-Preview feature
 * hidden from `claude --help`. The default mirrors the reference repo's
 * `claude --dangerously-load-development-channels server:slack-session`. If the
 * flag syntax differs in your Claude Code build, edit the template — no code
 * change needed.
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER_DIR = join(homedir(), '.claude', 'slack-router')
const STATE_FILE = join(ROUTER_DIR, 'supervisor-state.json')
mkdirSync(ROUTER_DIR, { recursive: true })

function log(msg: string): void {
  // ISO-ish timestamp without Date.now sensitivity issues at module load.
  process.stderr.write(`[supervisor] ${msg}\n`)
}

// ── Config ────────────────────────────────────────────────────────────────────
interface SessionConfig {
  name: string
  cwd: string
  bind?: string[]
  resume?: boolean
  extraArgs?: string
}
interface SupervisorConfig {
  checkIntervalMs: number
  minRespawnMs: number
  routerPort: number
  router: { enabled: boolean }
  claudeBin: string
  /** Template for the claude launch line run inside tmux. Placeholders:
   *  {cwd} {name} {bind} {tmux} {routerPort} {claudeBin} {resumeArg} {extra} */
  launchTemplate: string
  skipPermissions: boolean
  sessions: SessionConfig[]
}

const DEFAULT_TEMPLATE =
  'cd {cwd} && SLACK_MULTISESSION=1 SESSION_NAME={name} SLACK_BIND={bind} ' +
  'SLACK_TMUX_SESSION={tmux} ROUTER_PORT={routerPort} ' +
  '{claudeBin} --dangerously-load-development-channels server:slack-session {resumeArg} {extra}'

function defaultConfig(): SupervisorConfig {
  return {
    checkIntervalMs: 5000,
    minRespawnMs: 20_000,
    routerPort: 8801,
    router: { enabled: true },
    claudeBin: 'claude',
    launchTemplate: DEFAULT_TEMPLATE,
    skipPermissions: false,
    sessions: [],
  }
}

function loadConfig(path: string): SupervisorConfig {
  if (!existsSync(path)) {
    log(`No config at ${path} — copy supervisor.example.json there and edit it.`)
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SupervisorConfig>
  return { ...defaultConfig(), ...raw, router: { ...defaultConfig().router, ...(raw.router ?? {}) } }
}

// ── Persisted state (router pid, per-session uuid) ───────────────────────────
interface SupervisorState {
  routerPid: number | null
  sessions: Record<string, { sessionId: string; spawnedOnce: boolean; lastSpawnAt: number }>
}
let state: SupervisorState = { routerPid: null, sessions: {} }
function loadState(): void {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    /* fresh */
  }
}
function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── Liveness helpers ──────────────────────────────────────────────────────────
function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function tmuxHas(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function tmuxKill(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
  } catch {
    /* not running */
  }
}

async function routerHealth(port: number): Promise<{ sessions: Array<{ name: string }> } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as { sessions: Array<{ name: string }> }
  } catch {
    return null
  }
}

// ── Router child ──────────────────────────────────────────────────────────────
function ensureRouter(cfg: SupervisorConfig): void {
  if (!cfg.router.enabled) return
  if (pidAlive(state.routerPid)) return
  const tsx = join(HERE, 'node_modules', '.bin', 'tsx')
  const routerScript = join(HERE, 'slack-router.ts')
  const out = openSync(join(ROUTER_DIR, 'router.log'), 'a')
  const child = spawn(tsx, [routerScript], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ROUTER_PORT: String(cfg.routerPort) },
  })
  child.unref()
  state.routerPid = child.pid ?? null
  saveState()
  log(`spawned router (pid ${state.routerPid}) → ${join(ROUTER_DIR, 'router.log')}`)
}

// ── Session children (tmux) ──────────────────────────────────────────────────
function buildLaunch(cfg: SupervisorConfig, s: SessionConfig, tmuxName: string): string {
  const st = state.sessions[s.name]
  const resumeArg =
    s.resume && st.spawnedOnce ? `--resume ${st.sessionId}` : `--session-id ${st.sessionId}`
  const extra = [s.extraArgs ?? '', cfg.skipPermissions ? '--dangerously-skip-permissions' : '']
    .filter(Boolean)
    .join(' ')
  return cfg.launchTemplate
    .replaceAll('{cwd}', s.cwd)
    .replaceAll('{name}', s.name)
    .replaceAll('{bind}', (s.bind ?? []).join(','))
    .replaceAll('{tmux}', tmuxName)
    .replaceAll('{routerPort}', String(cfg.routerPort))
    .replaceAll('{claudeBin}', cfg.claudeBin)
    .replaceAll('{resumeArg}', resumeArg)
    .replaceAll('{extra}', extra)
}

function ensureSession(cfg: SupervisorConfig, s: SessionConfig, healthyNames: Set<string>): void {
  const tmuxName = `slack-${s.name}`
  if (!state.sessions[s.name]) {
    state.sessions[s.name] = { sessionId: randomUUID(), spawnedOnce: false, lastSpawnAt: 0 }
    saveState()
  }
  const st = state.sessions[s.name]

  const healthy = tmuxHas(tmuxName) && healthyNames.has(s.name)
  if (healthy) return

  const now = Date.now()
  if (now - st.lastSpawnAt < cfg.minRespawnMs) return // backoff

  // Clear a stale/half-dead tmux session before recreating.
  tmuxKill(tmuxName)
  const launch = buildLaunch(cfg, s, tmuxName)
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName], { stdio: 'ignore' })
    execFileSync('tmux', ['send-keys', '-t', tmuxName, launch, 'Enter'], { stdio: 'ignore' })
  } catch (err) {
    log(`failed to (re)spawn session "${s.name}": ${err}`)
    return
  }
  st.spawnedOnce = true
  st.lastSpawnAt = now
  saveState()
  log(`(re)spawned session "${s.name}" in tmux "${tmuxName}" (${s.resume ? 'resume' : 'fresh'})`)
}

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick(cfg: SupervisorConfig): Promise<void> {
  ensureRouter(cfg)
  const health = await routerHealth(cfg.routerPort)
  const healthyNames = new Set((health?.sessions ?? []).map(x => x.name))
  for (const s of cfg.sessions) ensureSession(cfg, s, healthyNames)
}

// ── Subcommands ────────────────────────────────────────────────────────────────
async function status(cfg: SupervisorConfig): Promise<void> {
  const health = await routerHealth(cfg.routerPort)
  log(`router pid ${state.routerPid ?? '—'} alive=${pidAlive(state.routerPid)} healthEndpoint=${health ? 'up' : 'down'}`)
  const live = new Set((health?.sessions ?? []).map(x => x.name))
  for (const s of cfg.sessions) {
    const tmuxName = `slack-${s.name}`
    log(`session ${s.name}: tmux=${tmuxHas(tmuxName)} registered=${live.has(s.name)} bind=[${(s.bind ?? []).join(',')}]`)
  }
}

function down(cfg: SupervisorConfig): void {
  for (const s of cfg.sessions) tmuxKill(`slack-${s.name}`)
  if (pidAlive(state.routerPid)) {
    try {
      process.kill(state.routerPid!, 'SIGTERM')
    } catch {
      /* ignore */
    }
  }
  state.routerPid = null
  saveState()
  log('down: killed session tmux windows + router')
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv.find(a => !a.startsWith('-')) ?? 'up'
  const cfgIdx = argv.indexOf('--config')
  const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : join(ROUTER_DIR, 'supervisor.json')
  const once = argv.includes('--once')

  loadState()
  const cfg = loadConfig(cfgPath)

  if (cfg.sessions.length > 0 && !tmuxAvailable()) {
    log('tmux is required to supervise sessions but was not found. Install it: brew install tmux')
    if (cmd === 'up') process.exit(1)
  }

  if (cmd === 'status') return status(cfg)
  if (cmd === 'down') return down(cfg)

  // up
  log(`supervising (router:${cfg.router.enabled} sessions:${cfg.sessions.length} interval:${cfg.checkIntervalMs}ms)`)
  await tick(cfg)
  if (once) return
  const timer = setInterval(() => {
    void tick(cfg).catch(err => log(`tick error: ${err}`))
  }, cfg.checkIntervalMs)
  // Keep the supervisor alive; leave children running on supervisor exit
  // (use `down` to tear them down explicitly).
  process.on('SIGTERM', () => {
    clearInterval(timer)
    log('supervisor stopping (children left running; use `down` to tear down)')
    process.exit(0)
  })
  process.on('SIGINT', () => {
    clearInterval(timer)
    log('supervisor stopping (children left running)')
    process.exit(0)
  })
}

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(1)
})
