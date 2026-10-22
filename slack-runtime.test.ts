import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { join } from 'node:path'

const root = import.meta.dir
const node = realpathSync(process.env.CCSC_TEST_NODE ?? Bun.which('node') ?? '')
const docker = Bun.which('docker')
// Official Ubuntu 24.04 linux/amd64 manifest. Provision explicitly before tests;
// no test downloads an image, starts a daemon, or changes host security policy.
const image =
  'docker.io/library/ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc'
const stem = 'scripts/slack-channel-runtime'
const artifacts = [`${stem}.mjs`, `${stem}.LICENSES.txt`, `${stem}.provenance.json`]
const maxOutput = 1024 * 1024
const deadlineMs = 10000
const uid = process.getuid?.()
const gid = process.getgid?.()
let temporary: string
let imageId: string
const owned = new Map<string, string>()

// This preload exists ONLY in a temporary fixture. Docker's separate network
// namespace also denies external access. The container receives only that
// fixture and a read-only Node binary; no checkout, host HOME or Docker socket.
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

function dockerSync(args: string[]) {
  const result = spawnSync(docker!, args, {
    encoding: 'utf8',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxOutput,
  })
  if (result.error || result.status !== 0)
    throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}

function inspectContainer(id: string) {
  return JSON.parse(dockerSync(['container', 'inspect', id]))[0]
}

// Query only this test's unpredictable exact name. Docker errors are failures,
// never mistaken for absence. Remove by inspected ID after checking ownership.
function cleanup(name: string, token: string) {
  const ids = dockerSync([
    'container',
    'ls',
    '--all',
    '--filter',
    `name=^/${name}$`,
    '--format',
    '{{.ID}}',
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
  if (ids.length > 1) throw new Error(`Ambiguous owned container: ${name}`)
  if (ids.length) {
    const details = inspectContainer(ids[0])
    expect(details.Name).toBe(`/${name}`)
    expect(details.Config.Labels['io.intentsolutions.ccsc-runtime-test']).toBe(token)
    dockerSync(['container', 'rm', '--force', details.Id])
  }
  expect(
    dockerSync([
      'container',
      'ls',
      '--all',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.ID}}',
    ]).trim(),
  ).toBe('')
  owned.delete(name)
}

beforeAll(() => {
  if (!docker) throw new Error('Docker is required: no unconfined protocol-test fallback')
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    uid === undefined ||
    gid === undefined ||
    uid === 0
  )
    throw new Error('Isolated protocol tests require Linux amd64 and a non-root user')
  const details = JSON.parse(dockerSync(['image', 'inspect', image]))[0]
  expect(details.Os).toBe('linux')
  expect(details.Architecture).toBe('amd64')
  expect(
    details.RepoDigests.some((ref: string) => ref.endsWith(image.slice(image.indexOf('@')))),
  ).toBe(true)
  imageId = details.Id
  temporary = mkdtempSync(join(tmpdir(), 'ccsc-runtime-'))
})

afterAll(() => {
  const failures: unknown[] = []
  try {
    for (const [name, token] of owned) {
      try {
        cleanup(name, token)
      } catch (error) {
        failures.push(error)
      }
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
  if (failures.length) throw new AggregateError(failures, 'Owned container cleanup failed')
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

function createContainer(dir: string, args: string[]) {
  const token = randomUUID()
  const name = `ccsc-runtime-${token}`
  owned.set(name, token)
  try {
    const id = dockerSync([
      'create',
      '--interactive',
      '--pull=never',
      '--platform=linux/amd64',
      '--name',
      name,
      '--label',
      `io.intentsolutions.ccsc-runtime-test=${token}`,
      '--network=none',
      '--pid=',
      '--ipc=private',
      '--user',
      `${uid}:${gid}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--memory=256m',
      '--memory-swap=256m',
      '--cpus=1',
      '--pids-limit=64',
      '--ulimit',
      'nofile=256:256',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--mount',
      `type=bind,source=${node},target=/node,readonly`,
      '--mount',
      `type=bind,source=${dir},target=/fixture`,
      '--env',
      'HOME=/fixture/home',
      '--env',
      'PATH=/nonexistent',
      '--env',
      'SLACK_STATE_DIR=/fixture/state',
      '--workdir',
      '/fixture/unrelated working directory',
      '--entrypoint',
      '/node',
      image,
      '--require',
      '/fixture/provider-fixture.cjs',
      ...args,
    ]).trim()
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    const details = inspectContainer(id)
    expect(details.Name).toBe(`/${name}`)
    expect(details.Config.Labels['io.intentsolutions.ccsc-runtime-test']).toBe(token)
    expect(details.Image).toBe(imageId)
    return { id, name, token }
  } catch (error) {
    cleanup(name, token)
    throw error
  }
}

function target(dir: string) {
  const config = JSON.parse(readFileSync(join(dir, 'copied plugin/.mcp.json'), 'utf8')).mcpServers
    .slack
  expect(config.command).toBe('node')
  expect(config.args).toHaveLength(1)
  return config.args[0].replace('${CLAUDE_PLUGIN_ROOT}', '/fixture/copied plugin')
}

function startCaptured(container: { id: string }) {
  return spawnSync(docker!, ['start', '--attach', '--interactive', container.id], {
    encoding: 'utf8',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxOutput,
  })
}

async function runProtocol(dir: string, args: string[], wallDeadline = deadlineMs) {
  const container = createContainer(dir, args)
  const child = spawn(docker!, ['start', '--attach', '--interactive', container.id], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let stdout = ''
  let stderr = ''
  let bytes = 0
  let timer: ReturnType<typeof setTimeout>
  const ids: number[] = []
  const result = new Promise<void>((accept, reject) => {
    // A fixed wall deadline applies even if output stops midway through a line.
    timer = setTimeout(() => reject(new Error('Isolated protocol deadline exceeded')), wallDeadline)
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > maxOutput) {
        reject(new Error('Isolated protocol output limit exceeded'))
        return
      }
      stderr += data.toString()
    })
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > maxOutput) {
        reject(new Error('Isolated protocol output limit exceeded'))
        return
      }
      stdout += data.toString()
      try {
        while (stdout.includes('\n')) {
          const offset = stdout.indexOf('\n')
          const line = JSON.parse(stdout.slice(0, offset))
          stdout = stdout.slice(offset + 1)
          ids.push(line.id)
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
    child.on('close', (code, signal) => {
      try {
        expect(code, `${signal}: ${stderr}`).toBe(0)
        expect(ids).toEqual([1, 2])
        expect(stdout).toBe('')
        expect(stderr).not.toContain('NETWORK_DENIED')
        expect(stderr).toContain('U_FIXTURE')
        accept()
      } catch (error) {
        reject(error)
      }
    })
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
  })
  try {
    await result
  } finally {
    clearTimeout(timer!)
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await new Promise<void>((resolve, reject) => {
        const reapTimer = setTimeout(
          () => reject(new Error('Owned Docker client did not exit')),
          3000,
        )
        closed.then(() => {
          clearTimeout(reapTimer)
          resolve()
        })
      })
    } finally {
      cleanup(container.name, container.token)
    }
  }
}

describe('copied native command with no provider network or dependency tree', () => {
  test('network preload rejects raw transports and provider-free tools', async () => {
    const dir = fixture()
    const provenance = JSON.parse(
      readFileSync(join(dir, 'copied plugin', `${stem}.provenance.json`), 'utf8'),
    )
    expect(provenance.format).toBe('ccsc-runtime-v1')
    // Consumer integrity binds the shipped artifacts. Full input reproduction
    // belongs to slack-runtime-build.test.ts in the canonical source checkout.
    for (const artifact of [`${stem}.mjs`, `${stem}.LICENSES.txt`])
      expect(
        createHash('sha256')
          .update(readFileSync(join(dir, 'copied plugin', artifact)))
          .digest('hex'),
      ).toBe(provenance.artifacts[artifact])
    const container = createContainer(dir, [
      '-e',
      String.raw`
      const fs = require('node:fs');
      for (const fn of [() => require('node:net').connect(443, 'slack.com'),
        () => require('node:tls').connect(443), () => require('node:dgram').createSocket('udp4'),
        () => require('node:dns').lookup('slack.com'), () => fetch('https://slack.com'),
        () => require('node:child_process').spawn('curl')]) {
        try { fn(); process.exit(2) } catch (error) { if (error.message !== 'NETWORK_DENIED') throw error; }
      }
      const rr = require('node:module').createRequire('/fixture/copied plugin/scripts/slack-channel-runtime.mjs');
      const missing = [];
      for (const name of ['@modelcontextprotocol/sdk/server/index.js', '@slack/web-api', '@slack/socket-mode', 'zod', 'tsx']) {
        try { rr.resolve(name); process.exit(3) }
        catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; missing.push(name); }
      }
      try { fs.writeFileSync('/rootfs-write-probe', 'x'); process.exit(4) }
      catch (error) { if (error.code !== 'EROFS') throw error; }
      if (fs.existsSync('/var/run/docker.sock')) throw Error('Docker socket mounted');
      console.log(JSON.stringify({version:process.version, uid:process.getuid(), gid:process.getgid(),
        net:fs.readlinkSync('/proc/self/ns/net'), pid:fs.readlinkSync('/proc/self/ns/pid'), missing,
        status:fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^(CapEff|NoNewPrivs):/.test(x))}));
    `,
    ])
    try {
      const result = startCaptured(container)
      expect(result.status, result.error?.message ?? result.stderr).toBe(0)
      const data = JSON.parse(result.stdout)
      expect(data.version).toMatch(/^v(?:20|2[2-9])\./)
      expect(data.uid).toBe(uid)
      expect(data.gid).toBe(gid)
      expect(data.net).not.toBe(readlinkSync('/proc/self/ns/net'))
      expect(data.pid).not.toBe(readlinkSync('/proc/self/ns/pid'))
      expect(data.missing).toHaveLength(5)
      expect(data.status.some((line: string) => /^CapEff:\s+0+$/.test(line))).toBe(true)
      expect(data.status.some((line: string) => /^NoNewPrivs:\s+1$/.test(line))).toBe(true)
      const details = inspectContainer(container.id)
      expect(details.Config.User).toBe(`${uid}:${gid}`)
      expect(details.HostConfig.NetworkMode).toBe('none')
      expect(details.HostConfig.PidMode).toBe('') // Docker's private default; '--pid=private' is invalid.
      expect(details.HostConfig.ReadonlyRootfs).toBe(true)
      expect(details.HostConfig.CapDrop).toEqual(['ALL'])
      expect(details.HostConfig.SecurityOpt).toContain('no-new-privileges')
      expect(details.HostConfig.Memory).toBe(256 * 1024 * 1024)
      expect(details.HostConfig.MemorySwap).toBe(256 * 1024 * 1024)
      expect(details.HostConfig.NanoCpus).toBe(1e9)
      expect(details.HostConfig.PidsLimit).toBe(64)
      expect(
        details.Mounts.map((mount: { Destination: string }) => mount.Destination).sort(),
      ).toEqual(['/fixture', '/node'])
      expect(
        details.Mounts.find((mount: { Destination: string }) => mount.Destination === '/node').RW,
      ).toBe(false)
    } finally {
      cleanup(container.name, container.token)
    }
    // Kill only the owned attach client. Its still-running container must be
    // removed by the same finally path used after protocol/parser failures.
    const idle = createContainer(dir, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      const result = spawnSync(docker!, ['start', '--attach', '--interactive', idle.id], {
        encoding: 'utf8',
        timeout: 500,
        killSignal: 'SIGKILL',
        maxBuffer: maxOutput,
      })
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT')
    } finally {
      cleanup(idle.name, idle.token)
    }
    await expect(
      runProtocol(dir, ['-e', "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)"]),
    ).rejects.toBeInstanceOf(SyntaxError)
    await expect(
      runProtocol(dir, ['-e', "process.stdout.write('{'); setInterval(() => {}, 1000)"], 3000),
    ).rejects.toThrow('Isolated protocol deadline exceeded')
    await expect(
      runProtocol(dir, [
        '-e',
        `process.stdout.write('x'.repeat(${maxOutput + 1})); setInterval(() => {}, 1000)`,
      ]),
    ).rejects.toThrow('Isolated protocol output limit exceeded')
  }, 30000)

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
      const container = createContainer(dir, [target(dir)])
      try {
        const result = startCaptured(container)
        expect(result.status, result.error?.message ?? result.stderr).toBe(1)
        expect(result.stderr).toContain(message)
        expect(result.stdout).toBe('')
      } finally {
        cleanup(container.name, container.token)
      }
    }, 20000)
  }

  test('initializes, declares Channels, lists tools and exits on closed stdio', async () => {
    const dir = fixture('SLACK_BOT_TOKEN=xoxb-fixture\nSLACK_APP_TOKEN=xapp-fixture\n')
    await runProtocol(dir, [target(dir)])
  }, 25000)
})
