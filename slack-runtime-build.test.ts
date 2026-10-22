import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = import.meta.dir
const node = realpathSync(process.env.CCSC_TEST_NODE ?? Bun.which('node') ?? '')
const stem = 'scripts/slack-channel-runtime'
const artifacts = [`${stem}.mjs`, `${stem}.LICENSES.txt`, `${stem}.provenance.json`]
let temporary: string
let buildCopy: string

beforeAll(() => {
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
      expect(p.inputs[path].sha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex'),
      )
    }
    expect(readFileSync(join(root, `${stem}.LICENSES.txt`), 'utf8')).toContain(
      'Copyright (c) 2013 Nathan Rajlich',
    )
    expect(readFileSync(join(root, `${stem}.LICENSES.txt`), 'utf8')).toContain(
      `===== NOTICE =====\n${readFileSync(join(root, 'NOTICE'), 'utf8').trimEnd()}\n`,
    )
  })
})
