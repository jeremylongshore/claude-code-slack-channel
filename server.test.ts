import { describe, test, expect } from 'bun:test'
import {
  gate,
  assertSendable,
  assertOutboundAllowed,
  chunkText,
  sanitizeFilename,
  defaultAccess,
  pruneExpired,
  generateCode,
  MAX_PENDING,
  MAX_PAIRING_REPLIES,
  PAIRING_EXPIRY_MS,
  type Access,
  type GateOptions,
} from './lib.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

function makeOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    access: makeAccess(),
    staticMode: false,
    saveAccess: () => {},
    botUserId: 'U_BOT',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

describe('gate', () => {
  test('drops messages with bot_id', async () => {
    const result = await gate(
      { bot_id: 'B123', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops message_changed subtype', async () => {
    const result = await gate(
      { subtype: 'message_changed', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops message_deleted subtype', async () => {
    const result = await gate(
      { subtype: 'message_deleted', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops channel_join subtype', async () => {
    const result = await gate(
      { subtype: 'channel_join', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('allows file_share subtype through', async () => {
    const access = makeAccess({ allowFrom: ['U123'] })
    const result = await gate(
      { subtype: 'file_share', user: 'U123', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops messages with no user field', async () => {
    const result = await gate(
      { channel_type: 'im', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  // -- DM: allowlist --

  test('delivers DMs from allowlisted users', async () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })
    const result = await gate(
      { user: 'U_ALLOWED', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
    expect(result.access).toBeDefined()
  })

  test('drops DMs when policy is allowlist and user not in list', async () => {
    const access = makeAccess({ dmPolicy: 'allowlist', allowFrom: ['U_OTHER'] })
    const result = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops DMs when policy is disabled', async () => {
    const access = makeAccess({ dmPolicy: 'disabled' })
    const result = await gate(
      { user: 'U_ANYONE', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  // -- DM: pairing --

  test('generates pairing code for unknown DM sender', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result = await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBeDefined()
    expect(result.code!.length).toBe(6)
    expect(result.isResend).toBe(false)
  })

  test('resends existing code on repeat DM from same user', async () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        ABC123: {
          senderId: 'U_REPEAT',
          chatId: 'D1',
          createdAt: Date.now(),
          expiresAt: Date.now() + PAIRING_EXPIRY_MS,
          replies: 1,
        },
      },
    })
    const result = await gate(
      { user: 'U_REPEAT', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBe('ABC123')
    expect(result.isResend).toBe(true)
  })

  test('drops after MAX_PAIRING_REPLIES reached', async () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        ABC123: {
          senderId: 'U_MAXED',
          chatId: 'D1',
          createdAt: Date.now(),
          expiresAt: Date.now() + PAIRING_EXPIRY_MS,
          replies: MAX_PAIRING_REPLIES,
        },
      },
    })
    const result = await gate(
      { user: 'U_MAXED', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops when MAX_PENDING codes reached', async () => {
    const pending: Access['pending'] = {}
    for (let i = 0; i < MAX_PENDING; i++) {
      pending[`CODE${i}`] = {
        senderId: `U_PEND${i}`,
        chatId: 'D1',
        createdAt: Date.now(),
        expiresAt: Date.now() + PAIRING_EXPIRY_MS,
        replies: 1,
      }
    }
    const access = makeAccess({ dmPolicy: 'pairing', pending })
    const result = await gate(
      { user: 'U_OVERFLOW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('calls saveAccess when pairing in non-static mode', async () => {
    let saved = false
    const access = makeAccess({ dmPolicy: 'pairing' })
    await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access, saveAccess: () => { saved = true } }),
    )
    expect(saved).toBe(true)
  })

  test('does NOT call saveAccess in static mode', async () => {
    let saved = false
    const access = makeAccess({ dmPolicy: 'pairing' })
    await gate(
      { user: 'U_NEW', channel_type: 'im', channel: 'D1' },
      makeOpts({ access, staticMode: true, saveAccess: () => { saved = true } }),
    )
    expect(saved).toBe(false)
  })

  // -- Channel opt-in --

  test('drops channel messages when channel not opted-in', async () => {
    const result = await gate(
      { user: 'U123', channel: 'C_UNKNOWN', channel_type: 'channel' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when channel is opted-in', async () => {
    const access = makeAccess({
      channels: { C_OPT: { requireMention: false, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_OPT', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops channel messages when requireMention and no mention', async () => {
    const access = makeAccess({
      channels: { C_MENTION: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_MENTION', channel_type: 'channel', text: 'hello' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when requireMention and bot is mentioned', async () => {
    const access = makeAccess({
      channels: { C_MENTION: { requireMention: true, allowFrom: [] } },
    })
    const result = await gate(
      { user: 'U123', channel: 'C_MENTION', channel_type: 'channel', text: 'hey <@U_BOT> help' },
      makeOpts({ access, botUserId: 'U_BOT' }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops channel messages when user not in channel allowFrom', async () => {
    const access = makeAccess({
      channels: { C_RESTRICTED: { requireMention: false, allowFrom: ['U_VIP'] } },
    })
    const result = await gate(
      { user: 'U_NOBODY', channel: 'C_RESTRICTED', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers channel messages when user is in channel allowFrom', async () => {
    const access = makeAccess({
      channels: { C_RESTRICTED: { requireMention: false, allowFrom: ['U_VIP'] } },
    })
    const result = await gate(
      { user: 'U_VIP', channel: 'C_RESTRICTED', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })
})

// ---------------------------------------------------------------------------
// assertSendable()
// ---------------------------------------------------------------------------

describe('assertSendable', () => {
  const stateDir = '/home/user/.claude/channels/slack'
  const inboxDir = '/home/user/.claude/channels/slack/inbox'

  test('blocks .env in state dir', () => {
    expect(() => assertSendable(`${stateDir}/.env`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('blocks access.json in state dir', () => {
    expect(() => assertSendable(`${stateDir}/access.json`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('blocks nested files in state dir', () => {
    expect(() => assertSendable(`${stateDir}/subdir/secret`, stateDir, inboxDir)).toThrow('Blocked')
  })

  test('allows files in inbox/', () => {
    expect(() => assertSendable(`${inboxDir}/photo.png`, stateDir, inboxDir)).not.toThrow()
  })

  test('allows files outside state dir entirely', () => {
    expect(() => assertSendable('/tmp/output.txt', stateDir, inboxDir)).not.toThrow()
  })

  test('allows home directory files', () => {
    expect(() => assertSendable('/home/user/project/file.ts', stateDir, inboxDir)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// assertOutboundAllowed()
// ---------------------------------------------------------------------------

describe('assertOutboundAllowed', () => {
  test('allows opted-in channels', () => {
    const access = makeAccess({
      channels: { C_OPT: { requireMention: false, allowFrom: [] } },
    })
    expect(() => assertOutboundAllowed('C_OPT', access, new Set())).not.toThrow()
  })

  test('allows delivered channels', () => {
    const access = makeAccess()
    const delivered = new Set(['D_DELIVERED'])
    expect(() => assertOutboundAllowed('D_DELIVERED', access, delivered)).not.toThrow()
  })

  test('blocks unknown channels', () => {
    const access = makeAccess()
    expect(() => assertOutboundAllowed('C_RANDO', access, new Set())).toThrow('Outbound gate')
  })

  test('blocks channels not in either list', () => {
    const access = makeAccess({
      channels: { C_OTHER: { requireMention: false, allowFrom: [] } },
    })
    const delivered = new Set(['D_DIFFERENT'])
    expect(() => assertOutboundAllowed('C_ATTACKER', access, delivered)).toThrow('Outbound gate')
  })
})

// ---------------------------------------------------------------------------
// chunkText()
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const result = chunkText('hello', 4000, 'newline')
    expect(result).toEqual(['hello'])
  })

  test('returns single chunk at exactly the limit', () => {
    const text = 'a'.repeat(4000)
    const result = chunkText(text, 4000, 'length')
    expect(result).toEqual([text])
  })

  test('chunks by fixed length', () => {
    const text = 'a'.repeat(10)
    const result = chunkText(text, 4, 'length')
    expect(result).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('chunks at newlines (paragraph-aware)', () => {
    const text = 'line1\nline2\nline3\nline4'
    const result = chunkText(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be <= 12 chars
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(12)
    }
  })

  test('newline mode keeps lines together when possible', () => {
    const text = 'short\nshort\nshort'
    const result = chunkText(text, 100, 'newline')
    expect(result).toEqual(['short\nshort\nshort'])
  })
})

// ---------------------------------------------------------------------------
// sanitizeFilename()
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  test('strips square brackets', () => {
    expect(sanitizeFilename('file[1].txt')).toBe('file_1_.txt')
  })

  test('strips newlines', () => {
    expect(sanitizeFilename('file\nname.txt')).toBe('file_name.txt')
  })

  test('strips carriage returns', () => {
    expect(sanitizeFilename('file\rname.txt')).toBe('file_name.txt')
  })

  test('strips semicolons', () => {
    expect(sanitizeFilename('file;name.txt')).toBe('file_name.txt')
  })

  test('replaces path traversal (..)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_/_/etc/passwd')
  })

  test('leaves clean names alone', () => {
    expect(sanitizeFilename('photo.png')).toBe('photo.png')
  })

  test('handles combined attack vector', () => {
    const result = sanitizeFilename('[../..\n;evil].txt')
    expect(result).not.toContain('[')
    expect(result).not.toContain('..')
    expect(result).not.toContain('\n')
    expect(result).not.toContain(';')
  })
})

// ---------------------------------------------------------------------------
// pruneExpired()
// ---------------------------------------------------------------------------

describe('pruneExpired', () => {
  test('removes expired codes', () => {
    const access = makeAccess({
      pending: {
        OLD: {
          senderId: 'U1',
          chatId: 'D1',
          createdAt: 0,
          expiresAt: 1, // long expired
          replies: 1,
        },
        FRESH: {
          senderId: 'U2',
          chatId: 'D2',
          createdAt: Date.now(),
          expiresAt: Date.now() + 999999,
          replies: 1,
        },
      },
    })
    pruneExpired(access)
    expect(access.pending['OLD']).toBeUndefined()
    expect(access.pending['FRESH']).toBeDefined()
  })

  test('handles empty pending', () => {
    const access = makeAccess()
    pruneExpired(access)
    expect(Object.keys(access.pending)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// generateCode()
// ---------------------------------------------------------------------------

describe('generateCode', () => {
  test('returns 6-character string', () => {
    const code = generateCode()
    expect(code.length).toBe(6)
  })

  test('only contains allowed characters (no 0/O/1/I)', () => {
    const forbidden = /[0O1I]/
    for (let i = 0; i < 100; i++) {
      expect(generateCode()).not.toMatch(forbidden)
    }
  })

  test('generates unique codes', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      codes.add(generateCode())
    }
    // With 30^6 = 729M possibilities, 50 codes should all be unique
    expect(codes.size).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// defaultAccess()
// ---------------------------------------------------------------------------

describe('defaultAccess', () => {
  test('returns pairing policy by default', () => {
    expect(defaultAccess().dmPolicy).toBe('pairing')
  })

  test('returns empty allowlist', () => {
    expect(defaultAccess().allowFrom).toEqual([])
  })

  test('returns empty channels', () => {
    expect(defaultAccess().channels).toEqual({})
  })

  test('returns empty pending', () => {
    expect(defaultAccess().pending).toEqual({})
  })
})
