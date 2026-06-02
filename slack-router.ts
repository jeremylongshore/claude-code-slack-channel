#!/usr/bin/env -S npx tsx
/**
 * slack-router — the single owner of the Slack Socket Mode connection for
 * multi-session routing.
 *
 * One router per machine. It runs the full inbound gate (allowlist / pairing /
 * policy) reused from lib.ts, holds the session registry + binding table, and
 * forwards each inbound Slack event to the bound Claude Code session over
 * loopback HTTP. Sessions post replies back through the router, which performs
 * the Slack side effect after re-checking the calling session is authorized
 * for the destination.
 *
 * Why a router: Slack load-balances Socket Mode events across all of an app's
 * connections, so multiple monolith processes cannot each "own" a channel.
 * Exactly one process owns the socket; sessions attach as clients.
 *
 * See docs/multi-session-routing.md.
 *
 * Env:
 *   ROUTER_PORT       — HTTP port sessions register on (default 8801)
 *   SLACK_STATE_DIR   — channel state dir (default ~/.claude/channels/slack)
 *   SLACK_ACCESS_MODE — 'static' to freeze access.json at boot (same as server.ts)
 */

import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  gate as libGate,
  defaultAccess,
  chunkText,
  isDuplicateEvent,
  deliveredThreadKey,
  sanitizeDisplayName,
  sanitizeFilename,
  EVENT_DEDUP_TTL_MS,
  PERMISSION_REPLY_RE,
  type Access,
  type GateResult,
} from './lib.ts'

// ── Paths & config ────────────────────────────────────────────────────────────
const ROUTER_PORT = Number(process.env.ROUTER_PORT ?? 8801)
const STATE_DIR = process.env.SLACK_STATE_DIR || join(homedir(), '.claude', 'channels', 'slack')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ROUTER_DIR = join(homedir(), '.claude', 'slack-router')
const STATE_FILE = join(ROUTER_DIR, 'state.json')
const STATIC_MODE = (process.env.SLACK_ACCESS_MODE || '').toLowerCase() === 'static'
const CHUNK_LIMIT = 3800 // Slack hard cap is 4000 chars/message; leave headroom.

mkdirSync(ROUTER_DIR, { recursive: true })

function log(msg: string): void {
  process.stderr.write(`slack-router: ${msg}\n`)
}

// ── Tokens (same loader contract as server.ts) ───────────────────────────────
function loadEnv(): { botToken: string; appToken: string } {
  if (!existsSync(ENV_FILE)) {
    log(`No .env found at ${ENV_FILE} — run /slack-channel:configure first.`)
    process.exit(1)
  }
  chmodSync(ENV_FILE, 0o600)
  const vars: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }
  const botToken = vars.SLACK_BOT_TOKEN || ''
  const appToken = vars.SLACK_APP_TOKEN || ''
  if (!botToken.startsWith('xoxb-')) {
    log('SLACK_BOT_TOKEN must start with xoxb-')
    process.exit(1)
  }
  if (!appToken.startsWith('xapp-')) {
    log('SLACK_APP_TOKEN must start with xapp-')
    process.exit(1)
  }
  return { botToken, appToken }
}

const { botToken, appToken } = loadEnv()
const web = new WebClient(botToken)
const socket = new SocketModeClient({ appToken })

let botUserId = ''
let selfBotId = ''
let selfAppId = ''

// ── Access (allowlist/pairing) — reused files, same as server.ts ─────────────
function loadAccess(): Access {
  if (!existsSync(ACCESS_FILE)) return defaultAccess()
  try {
    return { ...defaultAccess(), ...JSON.parse(readFileSync(ACCESS_FILE, 'utf-8')) }
  } catch {
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt.${Date.now()}`)
    } catch {
      /* ignore */
    }
    return defaultAccess()
  }
}
function saveAccess(access: Access): void {
  const tmp = `${ACCESS_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(access, null, 2), { mode: 0o600, flag: 'w' })
  renameSync(tmp, ACCESS_FILE)
}
const staticAccess: Access | null = STATIC_MODE ? loadAccess() : null
function getAccess(): Access {
  return STATIC_MODE && staticAccess ? staticAccess : loadAccess()
}

async function gate(event: unknown): Promise<GateResult> {
  return libGate(event, {
    access: getAccess(),
    staticMode: STATIC_MODE,
    saveAccess,
    botUserId,
    selfBotId,
    selfAppId,
  })
}

// ── Session registry + binding table ─────────────────────────────────────────
interface SessionEntry {
  name: string
  port: number
  pid: number
  registeredAt: number
  lastHeartbeat: number
  claims: string[]
}
interface Bindings {
  threads: Record<string, string> // "C:threadTs" -> session name
  channels: Record<string, string> // "C" -> session name
  default: string | null
}
interface RouterState {
  sessions: Record<string, SessionEntry>
  bindings: Bindings
}

let state: RouterState = { sessions: {}, bindings: { threads: {}, channels: {}, default: null } }

function loadState(): void {
  try {
    const loaded = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<RouterState>
    state = {
      sessions: loaded.sessions ?? {},
      bindings: {
        threads: loaded.bindings?.threads ?? {},
        channels: loaded.bindings?.channels ?? {},
        default: loaded.bindings?.default ?? null,
      },
    }
  } catch {
    /* fresh state */
  }
}
function saveState(): void {
  const tmp = `${STATE_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, STATE_FILE)
}

function isAlive(s: SessionEntry | undefined): s is SessionEntry {
  if (!s) return false
  try {
    process.kill(s.pid, 0)
  } catch {
    return false
  }
  return Date.now() - s.lastHeartbeat <= 30_000
}

/** Resolve the session that owns an inbound (channel, thread). thread override
 *  → channel binding → default. Only returns a live session. */
function resolveSession(channel: string, threadTs: string | undefined): SessionEntry | null {
  const b = state.bindings
  if (threadTs) {
    const name = b.threads[`${channel}:${threadTs}`]
    if (name && isAlive(state.sessions[name])) return state.sessions[name]
  }
  const chName = b.channels[channel]
  if (chName && isAlive(state.sessions[chName])) return state.sessions[chName]
  if (b.default && isAlive(state.sessions[b.default])) return state.sessions[b.default]
  return null
}

// Tracks which session last received a given (channel, thread) so it may reply
// even before an explicit binding exists (mirrors server.ts deliveredThreads,
// now scoped per session).
const deliveredBy = new Map<string, string>() // deliveredThreadKey -> session name
// Most-recent delivered destination per session, for routing permission prompts.
const lastDest = new Map<string, { channel: string; threadTs?: string }>()

function sessionAuthorizedFor(session: string, channel: string, threadTs: string | undefined): boolean {
  const resolved = resolveSession(channel, threadTs)
  if (resolved?.name === session) return true
  return deliveredBy.get(deliveredThreadKey(channel, threadTs)) === session
}

// ── Dead-session reaper ───────────────────────────────────────────────────────
function reap(): void {
  let changed = false
  for (const [name, s] of Object.entries(state.sessions)) {
    if (!isAlive(s)) {
      log(`session "${name}" dead (pid ${s.pid}) — removing`)
      delete state.sessions[name]
      if (state.bindings.default === name) state.bindings.default = null
      changed = true
    }
  }
  if (changed) saveState()
}
setInterval(reap, 15_000).unref()

// ── Forwarding to sessions ────────────────────────────────────────────────────
async function postToSession(s: SessionEntry, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Outbound Slack helpers (used by HTTP handlers) ───────────────────────────
async function sendReply(args: {
  chat_id: string
  thread_ts?: string
  text: string
}): Promise<string> {
  const chunks = chunkText(args.text, CHUNK_LIMIT, 'newline')
  let last = ''
  for (const chunk of chunks) {
    const res = await web.chat.postMessage({
      channel: args.chat_id,
      text: chunk,
      thread_ts: args.thread_ts,
      unfurl_links: false,
      unfurl_media: false,
    })
    last = (res.ts as string) || last
  }
  return chunks.length === 1 ? `sent (ts: ${last})` : `sent ${chunks.length} parts (last ts: ${last})`
}

// ── Permission relay state ────────────────────────────────────────────────────
const pendingPermissions = new Map<
  string,
  { session: string; channel: string; threadTs?: string; tool_name: string }
>()

// ── Commands (intercepted before gate/forward) ───────────────────────────────
const COMMAND_RE = /^!(\w+)\s*(.*)$/

function sessionList(): string {
  const names = Object.keys(state.sessions)
  if (names.length === 0) return 'No sessions connected.'
  return names
    .map(n => {
      const s = state.sessions[n]
      const live = isAlive(s) ? '●' : '○'
      const def = state.bindings.default === n ? ' (default)' : ''
      const claims = s.claims.length ? ` claims: ${s.claims.join(', ')}` : ''
      return `${live} ${n} (pid ${s.pid})${def}${claims}`
    })
    .join('\n')
}

function bindingsForChannel(channel: string): string {
  const lines: string[] = []
  const ch = state.bindings.channels[channel]
  if (ch) lines.push(`channel → ${ch}`)
  for (const [k, v] of Object.entries(state.bindings.threads)) {
    if (k.startsWith(`${channel}:`)) lines.push(`thread ${k.split(':')[1]} → ${v}`)
  }
  if (state.bindings.default) lines.push(`default → ${state.bindings.default}`)
  return lines.length ? lines.join('\n') : '(no bindings)'
}

/** Handle a `!command`. Returns true if the message was a command (and was
 *  handled — no further routing). Only allowlisted users reach here. */
async function handleCommand(
  text: string,
  channel: string,
  threadTs: string | undefined,
): Promise<boolean> {
  const m = COMMAND_RE.exec(text.trim())
  if (!m) return false
  const cmd = m[1].toLowerCase()
  const arg = m[2].trim()
  const replyInThread = threadTs
  const say = (t: string) => sendReply({ chat_id: channel, thread_ts: replyInThread, text: t })

  switch (cmd) {
    case 'sessions':
      await say(sessionList())
      return true
    case 'route': {
      const r = resolveSession(channel, threadTs)
      await say(
        r
          ? `This ${threadTs ? 'thread' : 'channel'} routes to: ${r.name}`
          : `Unbound — no session resolves here. Use !bind <name>.\n\nConnected:\n${sessionList()}`,
      )
      return true
    }
    case 'bind': {
      if (!arg) {
        await say('Usage: !bind <session-name>')
        return true
      }
      if (!state.sessions[arg]) {
        await say(`Session "${arg}" not connected.\n\n${sessionList()}`)
        return true
      }
      if (threadTs) {
        state.bindings.threads[`${channel}:${threadTs}`] = arg
        saveState()
        await say(`Bound this thread → ${arg}`)
      } else {
        state.bindings.channels[channel] = arg
        saveState()
        await say(`Bound this channel → ${arg}`)
      }
      return true
    }
    case 'unbind': {
      if (threadTs && state.bindings.threads[`${channel}:${threadTs}`]) {
        delete state.bindings.threads[`${channel}:${threadTs}`]
        saveState()
        await say('Unbound this thread.')
      } else if (state.bindings.channels[channel]) {
        delete state.bindings.channels[channel]
        saveState()
        await say('Unbound this channel.')
      } else {
        await say('Nothing bound here.')
      }
      return true
    }
    case 'default':
    case 'switch': {
      if (!arg) {
        await say(`Usage: !${cmd} <session-name>`)
        return true
      }
      if (!state.sessions[arg]) {
        await say(`Session "${arg}" not connected.\n\n${sessionList()}`)
        return true
      }
      state.bindings.default = arg
      saveState()
      await say(`Default session → ${arg}`)
      return true
    }
    case 'help':
      await say(
        'Multi-session router commands:\n' +
          '!sessions — list connected sessions\n' +
          '!bind <name> — bind this channel (or thread) to a session\n' +
          '!unbind — remove this channel/thread binding\n' +
          '!route — show where this channel/thread routes\n' +
          '!default <name> — set the fallback session',
      )
      return true
    default:
      return false // unknown !word — treat as normal message
  }
}

// ── Inbound handling ──────────────────────────────────────────────────────────
const seenEvents = new Map<string, number>()

function stripMention(text: string): string {
  if (!botUserId) return text
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()
}

async function handleMessage(event: unknown): Promise<void> {
  const ev = event as Record<string, unknown>
  if (isDuplicateEvent(ev, seenEvents, Date.now(), EVENT_DEDUP_TTL_MS)) return

  const result = await gate(event)

  if (result.action === 'drop') return

  const channelId = ev.channel as string
  const threadTs = ev.thread_ts as string | undefined
  const userId = ev.user as string | undefined

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await sendReply({
      chat_id: channelId,
      thread_ts: threadTs,
      text: `${lead} — run in Claude Code:\n\n/slack-channel:access pair ${result.code}`,
    }).catch(() => {})
    return
  }

  const access = result.access ?? getAccess()
  const text = stripMention((ev.text as string | undefined) || '')

  // Command intercept (allowlisted users only).
  if (userId && access.allowFrom.includes(userId) && text.startsWith('!')) {
    if (await handleCommand(text, channelId, threadTs)) return
  }

  // Permission reply intercept: "y <code>" / "n <code>".
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch && userId && access.allowFrom.includes(userId)) {
    const requestId = permMatch[2].toLowerCase()
    const pending = pendingPermissions.get(requestId)
    if (pending) {
      const behavior = permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
      const s = state.sessions[pending.session]
      if (isAlive(s)) {
        await postToSession(s, '/permission_verdict', { request_id: requestId, behavior })
      }
      pendingPermissions.delete(requestId)
      try {
        await web.reactions.add({
          channel: channelId,
          timestamp: ev.ts as string,
          name: behavior === 'allow' ? 'white_check_mark' : 'heavy_multiplication_x',
        })
      } catch {
        /* non-critical */
      }
    }
    return
  }

  // Resolve the destination session.
  const session = resolveSession(channelId, threadTs)
  if (!session) {
    // Only nudge on a DM or an explicit @mention to avoid channel noise.
    const isDm = channelId.startsWith('D')
    const mentioned = botUserId && ((ev.text as string) || '').includes(`<@${botUserId}>`)
    if (isDm || mentioned) {
      await sendReply({
        chat_id: channelId,
        thread_ts: threadTs,
        text: `No session is bound here. Bind one with !bind <name>.\n\n${sessionList()}`,
      }).catch(() => {})
    }
    return
  }

  // Mark delivered (enables this session's outbound to this thread).
  const dkey = deliveredThreadKey(channelId, threadTs)
  deliveredBy.set(dkey, session.name)
  lastDest.set(session.name, { channel: channelId, threadTs })

  // Ack reaction.
  if (access.ackReaction) {
    try {
      await web.reactions.add({ channel: channelId, timestamp: ev.ts as string, name: access.ackReaction })
    } catch {
      /* non-critical */
    }
  }

  // Build meta for the <channel> tag.
  const rawUserId = (ev.user as string) || ''
  const userIdSafe = /^[A-Z0-9]{1,32}$/.test(rawUserId) ? rawUserId : 'invalid'
  const userName = await resolveUserName(rawUserId)
  const meta: Record<string, string> = {
    chat_id: channelId,
    message_id: ev.ts as string,
    user_id: userIdSafe,
    user: userName,
    ts: ev.ts as string,
  }
  if (threadTs) meta.thread_ts = threadTs
  const evFiles = ev.files as Array<Record<string, unknown>> | undefined
  if (evFiles?.length) {
    meta.attachment_count = String(evFiles.length)
    meta.attachments = evFiles
      .map(f => `${sanitizeFilename((f.name as string) || 'unnamed')} (${f.mimetype || 'unknown'}, ${f.size || '?'} bytes)`)
      .join('; ')
  }

  const ok = await postToSession(session, '/message', { content: text, meta })
  if (!ok) {
    await sendReply({
      chat_id: channelId,
      thread_ts: threadTs,
      text: `Could not reach session "${session.name}" — it may have disconnected.`,
    }).catch(() => {})
  }
}

// ── User name resolution (sanitized, cached) ─────────────────────────────────
const userNameCache = new Map<string, string>()
async function resolveUserName(userId: string): Promise<string> {
  if (!userId) return 'unknown'
  if (userNameCache.has(userId)) return userNameCache.get(userId)!
  try {
    const res = await web.users.info({ user: userId })
    const raw =
      res.user?.profile?.display_name || res.user?.profile?.real_name || res.user?.name || userId
    const name = sanitizeDisplayName(raw)
    userNameCache.set(userId, name)
    return name
  } catch {
    return sanitizeDisplayName(userId)
  }
}

// ── HTTP server (sessions → router) ──────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const http = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      // Live sessions only (ground truth for the supervisor) + current bindings.
      const live = Object.values(state.sessions)
        .filter(isAlive)
        .map(s => ({ name: s.name, pid: s.pid, claims: s.claims }))
      return sendJson(res, 200, { ok: true, sessions: live, bindings: state.bindings })
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      return res.end('not found')
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad json' })
    }

    try {
      switch (url.pathname) {
        case '/register': {
          const { name, port, pid, claims } = body as {
            name: string
            port: number
            pid: number
            claims?: string[]
          }
          if (!name || !port || !pid) return sendJson(res, 400, { ok: false, error: 'missing fields' })
          const existing = state.sessions[name]
          if (existing && existing.pid !== pid && isAlive(existing)) {
            return sendJson(res, 409, { ok: false, error: `name "${name}" in use by a live session` })
          }
          const now = Date.now()
          state.sessions[name] = {
            name,
            port,
            pid,
            registeredAt: existing?.registeredAt ?? now,
            lastHeartbeat: now,
            claims: claims ?? [],
          }
          // Apply declared channel claims (first-live-wins; no silent steal).
          for (const claim of claims ?? []) {
            const ch = claim.replace(/^#/, '')
            const cur = state.bindings.channels[ch]
            if (!cur || !isAlive(state.sessions[cur])) {
              state.bindings.channels[ch] = name
            } else if (cur !== name) {
              log(`claim conflict: ${ch} already bound to live session "${cur}"; ignoring claim by "${name}"`)
            }
          }
          // First session becomes the default fallback.
          if (!state.bindings.default || !isAlive(state.sessions[state.bindings.default])) {
            state.bindings.default = name
          }
          saveState()
          return sendJson(res, 200, { ok: true, bindings: state.bindings })
        }
        case '/unregister': {
          const { name } = body as { name: string }
          delete state.sessions[name]
          if (state.bindings.default === name) state.bindings.default = null
          saveState()
          return sendJson(res, 200, { ok: true })
        }
        case '/reply': {
          const { session, chat_id, thread_ts, text } = body as {
            session: string
            chat_id: string
            thread_ts?: string
            text: string
          }
          if (!sessionAuthorizedFor(session, chat_id, thread_ts)) {
            return sendJson(res, 403, { ok: false, error: 'session not bound to this destination' })
          }
          const summary = await sendReply({ chat_id, thread_ts, text })
          return sendJson(res, 200, { ok: true, text: summary })
        }
        case '/react': {
          const { session, chat_id, message_id, emoji, thread_ts } = body as {
            session: string
            chat_id: string
            message_id: string
            emoji: string
            thread_ts?: string
          }
          if (!sessionAuthorizedFor(session, chat_id, thread_ts)) {
            return sendJson(res, 403, { ok: false, error: 'session not bound to this destination' })
          }
          await web.reactions.add({ channel: chat_id, timestamp: message_id, name: emoji.replace(/:/g, '') })
          return sendJson(res, 200, { ok: true, text: 'reacted' })
        }
        case '/edit': {
          const { session, chat_id, message_id, text, thread_ts } = body as {
            session: string
            chat_id: string
            message_id: string
            text: string
            thread_ts?: string
          }
          if (!sessionAuthorizedFor(session, chat_id, thread_ts)) {
            return sendJson(res, 403, { ok: false, error: 'session not bound to this destination' })
          }
          await web.chat.update({ channel: chat_id, ts: message_id, text })
          return sendJson(res, 200, { ok: true, text: 'edited' })
        }
        case '/fetch_messages': {
          const { session, channel, limit, thread_ts } = body as {
            session: string
            channel: string
            limit?: number
            thread_ts?: string
          }
          if (!sessionAuthorizedFor(session, channel, thread_ts)) {
            return sendJson(res, 403, { ok: false, error: 'session not bound to this destination' })
          }
          const n = Math.min(limit ?? 20, 100)
          const resp = thread_ts
            ? await web.conversations.replies({ channel, ts: thread_ts, limit: n })
            : await web.conversations.history({ channel, limit: n })
          const msgs = (resp.messages ?? [])
            .map(m => `[${m.ts}] ${sanitizeDisplayName((m as Record<string, unknown>).user as string ?? 'bot')}: ${m.text ?? ''}`)
            .join('\n')
          return sendJson(res, 200, { ok: true, text: msgs || '(no messages)' })
        }
        case '/download_attachment': {
          // Phase 2 — needs the file URL + auth-bearer download into the inbox dir.
          return sendJson(res, 200, {
            ok: false,
            error: 'download_attachment is not yet supported in multi-session mode (Phase 2)',
          })
        }
        case '/permission_request': {
          const { session, request_id, tool_name, description, input_preview } = body as {
            session: string
            request_id: string
            tool_name: string
            description: string
            input_preview: string
          }
          const dest = lastDest.get(session)
          if (!dest) {
            return sendJson(res, 200, { ok: false, error: 'no known destination for session' })
          }
          pendingPermissions.set(request_id.toLowerCase(), {
            session,
            channel: dest.channel,
            threadTs: dest.threadTs,
            tool_name,
          })
          await sendReply({
            chat_id: dest.channel,
            thread_ts: dest.threadTs,
            text:
              `🔐 *Permission request* from session \`${session}\`\n` +
              `Tool: \`${tool_name}\` — ${description}\n` +
              `\`\`\`${input_preview}\`\`\`\n` +
              `Reply \`y ${request_id}\` to allow or \`n ${request_id}\` to deny.`,
          }).catch(() => {})
          return sendJson(res, 200, { ok: true })
        }
        default:
          res.writeHead(404)
          res.end('not found')
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
})

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  loadState()

  const auth = (await web.auth.test()) as { user_id?: string; bot_id?: string }
  botUserId = auth.user_id ?? ''
  selfBotId = auth.bot_id ?? ''
  selfAppId = ''
  log(`authenticated as bot user ${botUserId}`)

  socket.on('message', async ({ event, ack }) => {
    await ack()
    if (!event) return
    try {
      await handleMessage(event)
    } catch (err) {
      log(`error handling message: ${err}`)
    }
  })
  socket.on('app_mention', async ({ event, ack }) => {
    await ack()
    if (!event) return
    try {
      await handleMessage(event)
    } catch (err) {
      log(`error handling mention: ${err}`)
    }
  })

  await new Promise<void>(resolve => http.listen(ROUTER_PORT, '127.0.0.1', resolve))
  log(`HTTP server on 127.0.0.1:${ROUTER_PORT}`)

  await socket.start()
  log('Socket Mode connected — routing inbound events to sessions')
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(1)
})
