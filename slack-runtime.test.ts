import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = import.meta.dir
const node = realpathSync(process.env.CCSC_TEST_NODE ?? Bun.which('node') ?? '')
const bwrap = Bun.which('bwrap')
const stem = 'scripts/slack-channel-runtime'
const artifacts = [`${stem}.mjs`, `${stem}.LICENSES.txt`, `${stem}.provenance.json`]
let temporary: string
let buildCopy: string

// This preload exists ONLY in a temporary test fixture. Network syscalls are
// additionally denied by bwrap's private network namespace. Neither the real
// HOME nor the checkout/node_modules are mounted in the server namespace.
const preload = String.raw`
const { PassThrough } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');
const deny = () => { throw new Error('NETWORK_DENIED'); };
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:http2').connect = deny;
require('node:dgram').createSocket = deny;
const dns = require('node:dns');
for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key)) dns[key] = deny;
for (const key of Object.keys(dns.promises)) dns.promises[key] = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
const child = require('node:child_process');
for (const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']) child[name] = deny;
function request(options, callback) {
  const request = new PassThrough();
  request.setTimeout = () => request;
  request.setHeader = () => request;
  request.getHeader = () => undefined;
  request.removeHeader = () => request;
  request.abort = () => request.destroy();
  request.end = () => {
    if (options.hostname !== 'slack.com') deny();
    if (options.path === '/api/apps.connections.open') return request;
    if (options.path !== '/api/auth.test') deny();
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.req = request;
      callback(response);
      response.end(JSON.stringify({ ok: true, user_id: 'U_FIXTURE', bot_id: 'B_FIXTURE' }));
    });
    return request;
  };
  return request;
}
for (const name of ['node:http','node:https']) {
  const module = require(name);
  module.request = request;
  module.get = deny;
}
syncBuiltinESMExports();
`

beforeAll(() => {
  if (!bwrap) throw new Error('bubblewrap is required: no unconfined protocol-test fallback')
  temporary = mkdtempSync(join(tmpdir(), 'ccsc-runtime-'))
  buildCopy = join(temporary, 'different build path')
  mkdirSync(buildCopy)
  const provenance = JSON.parse(readFileSync(join(root, `${stem}.provenance.json`), 'utf8'))
  for (const name of Object.keys(provenance.inputs).filter(
    (name) => !name.startsWith('node_modules/'),
  )) {
    mkdirSync(dirname(join(buildCopy, name)), { recursive: true })
    cpSync(join(root, name), join(buildCopy, name))
  }
  // Hard links preserve cached dependency bytes without downloading/installing
  // or searching an ancestor cache. No test modifies a dependency file.
  const copy = spawnSync('cp', ['-al', join(root, 'node_modules'), join(buildCopy, 'node_modules')])
  expect(copy.status).toBe(0)
  for (const file of artifacts) cpSync(join(root, file), join(buildCopy, file))
})
afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
})

function build(args: string[] = ['--check']) {
  return spawnSync(node, [join(buildCopy, 'scripts/build-runtime.mjs'), ...args], {
    cwd: temporary,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
  })
}

describe('deterministic runtime distribution', () => {
  test('regenerates exact artifacts from a different path and cwd', () => {
    const result = build([])
    expect(result.status, result.stderr).toBe(0)
    for (const file of artifacts)
      expect(readFileSync(join(buildCopy, file))).toEqual(readFileSync(join(root, file)))
  }, 20000)

  for (const file of artifacts) {
    test(`rejects altered and missing ${file}`, () => {
      const path = join(buildCopy, file)
      const original = readFileSync(path)
      try {
        writeFileSync(path, 'tampered')
        expect(build().status).not.toBe(0)
        rmSync(path)
        expect(build().status).not.toBe(0)
      } finally {
        writeFileSync(path, original)
      }
    }, 30000)
  }

  test('rejects dependency version drift against the lock', () => {
    const path = join(buildCopy, 'bun.lock')
    const original = readFileSync(path, 'utf8')
    try {
      writeFileSync(path, original.replace('@slack/socket-mode@2.0.6', '@slack/socket-mode@2.0.7'))
      const result = build()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Dependency does not match lock')
    } finally {
      writeFileSync(path, original)
    }
  }, 20000)

  test('rejects a nonliteral runtime module load', () => {
    const path = join(buildCopy, 'server.ts')
    const original = readFileSync(path, 'utf8')
    try {
      writeFileSync(
        path,
        `${original}\nconst unknownModule = process.env.MODULE; require(unknownModule);\n`,
      )
      const result = build()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Nonliteral module load')
    } finally {
      writeFileSync(path, original)
    }
  }, 20000)

  test('rejects an external that is not a real Node builtin', () => {
    const path = join(buildCopy, 'server.ts')
    const original = readFileSync(path, 'utf8')
    try {
      writeFileSync(path, `${original}\nimport 'node:ccsc_unknown';\n`)
      const result = build()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Unexpected external module')
    } finally {
      writeFileSync(path, original)
    }
  }, 20000)

  test('records consumed JSON assets and the complete license receipts', () => {
    const p = JSON.parse(readFileSync(join(root, `${stem}.provenance.json`), 'utf8'))
    expect(p.externals).toContain('node:module') // The generated banner is outside esbuild's metafile.
    expect(Object.keys(p.inputs).some((path) => path.endsWith('mime-db/db.json'))).toBe(true)
    for (const path of Object.keys(p.inputs)) {
      expect(p.inputs[path]).toBe(
        createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex'),
      )
    }
    expect(readFileSync(join(root, `${stem}.LICENSES.txt`), 'utf8')).toContain(
      'Copyright (c) 2013 Nathan Rajlich',
    )
  })
})

function fixture(credentials?: string) {
  const dir = mkdtempSync(join(temporary, 'launch '))
  for (const name of ['copied plugin/scripts', 'home', 'state', 'unrelated working directory'])
    mkdirSync(join(dir, name), { recursive: true })
  for (const file of artifacts) cpSync(join(root, file), join(dir, 'copied plugin', file))
  cpSync(join(root, '.mcp.json'), join(dir, 'copied plugin/.mcp.json'))
  writeFileSync(join(dir, 'provider-fixture.cjs'), preload)
  if (credentials !== undefined)
    writeFileSync(join(dir, 'state/.env'), credentials, { mode: 0o600 })
  return dir
}
function sandbox(dir: string, args: string[]) {
  return [
    '--unshare-net',
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    dir,
    '/fixture',
    '--ro-bind',
    node,
    '/node',
    '--chdir',
    '/fixture/unrelated working directory',
    '--clearenv',
    '--setenv',
    'HOME',
    '/fixture/home',
    '--setenv',
    'PATH',
    '/nonexistent',
    '--setenv',
    'SLACK_STATE_DIR',
    '/fixture/state',
    '/node',
    '--require',
    '/fixture/provider-fixture.cjs',
    ...args,
  ]
}
function target(dir: string) {
  const config = JSON.parse(readFileSync(join(dir, 'copied plugin/.mcp.json'), 'utf8')).mcpServers
    .slack
  expect(config.command).toBe('node')
  expect(config.args).toHaveLength(1)
  return config.args[0].replace('${CLAUDE_PLUGIN_ROOT}', '/fixture/copied plugin')
}

describe('copied native command with no provider network or dependency tree', () => {
  test('network preload rejects raw transports and provider-free tools', () => {
    const dir = fixture()
    const result = spawnSync(
      bwrap!,
      sandbox(dir, [
        '-e',
        `
      for (const fn of [() => require('node:net').connect(443, 'slack.com'),
        () => require('node:tls').connect(443), () => require('node:dgram').createSocket('udp4'),
        () => require('node:dns').lookup('slack.com'), () => fetch('https://slack.com'),
        () => require('node:child_process').spawn('curl')]) {
        try { fn(); process.exit(2) } catch (error) { if (error.message !== 'NETWORK_DENIED') throw error; }
      }
      const runtimeRequire = require('node:module').createRequire('/fixture/copied plugin/scripts/slack-channel-runtime.mjs');
      // Probe the SDK's real exported entry: its bare package root is absent even when installed.
      for (const name of ['@modelcontextprotocol/sdk/server/index.js', '@slack/web-api',
        '@slack/socket-mode', 'zod', 'tsx']) {
        try { runtimeRequire.resolve(name); process.exit(3) }
        catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      }
      console.log(process.version);
      console.log(require('node:fs').readlinkSync('/proc/self/ns/net'));
    `,
      ]),
      { encoding: 'utf8', timeout: 10000 },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.split('\n')[0]).toMatch(/^v(?:20|2[2-9])\./)
    expect(result.stdout.split('\n')[1]).not.toBe(readlinkSync('/proc/self/ns/net'))
  })

  for (const [label, credentials, message] of [
    ['missing', undefined, 'No .env found'],
    [
      'malformed bot',
      'SLACK_BOT_TOKEN=invalid\nSLACK_APP_TOKEN=xapp-fixture\n',
      'SLACK_BOT_TOKEN must start',
    ],
    [
      'malformed app',
      'SLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=invalid\n',
      'SLACK_APP_TOKEN must start',
    ],
  ] as const) {
    test(`${label} credentials fail through the actual copied entry`, () => {
      const dir = fixture(credentials)
      const result = spawnSync(bwrap!, sandbox(dir, [target(dir)]), {
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain(message)
      expect(result.stdout).toBe('')
    })
  }

  test('initializes, declares Channels, lists tools and exits on closed stdio', async () => {
    const dir = fixture('SLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n')
    const child = spawn(bwrap!, sandbox(dir, [target(dir)]), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const lines: Array<Record<string, unknown>> = []
    const result = new Promise<void>((accept, reject) => {
      child.stdout.on('data', (data) => {
        stdout += data
        try {
          while (stdout.includes('\n')) {
            const offset = stdout.indexOf('\n')
            const line = JSON.parse(stdout.slice(0, offset))
            stdout = stdout.slice(offset + 1)
            lines.push(line)
            if (line.id === 1) {
              expect(line.result.serverInfo).toEqual({ name: 'slack', version: '0.1.0' })
              expect(line.result.capabilities.experimental).toEqual({
                'claude/channel': {},
                'claude/channel/permission': {},
              })
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
              )
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
              )
            }
            if (line.id === 2) {
              expect(line.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
                'download_attachment',
                'edit_message',
                'fetch_messages',
                'list_sessions',
                'publish_manifest',
                'react',
                'read_peer_manifests',
                'reply',
              ])
              child.stdin.end()
            }
          }
        } catch (error) {
          reject(error)
        }
      })
      child.on('error', reject)
      child.stdin.on('error', reject)
      child.on('exit', (code, signal) => {
        try {
          expect(code, `${signal}: ${stderr}`).toBe(0)
          expect(lines.map((line) => line.id)).toContain(2)
          expect(stdout).toBe('')
          expect(stderr).not.toContain('NETWORK_DENIED')
          expect(stderr).toContain('U_FIXTURE')
          accept()
        } catch (error) {
          reject(error)
        }
      })
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 10000)
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'offline-fixture', version: '1' },
          },
        })}\n`,
      )
      await result
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 15000)
})
