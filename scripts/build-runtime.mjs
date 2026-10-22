#!/usr/bin/env node
// ccsc-udf: reproducible copied-plugin distribution. Never execute the server.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version as esbuildVersion } from 'esbuild'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stem = 'scripts/slack-channel-runtime'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const read = (path) => readFileSync(join(root, path))
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/build-runtime.mjs [--check]')
}
const check = args[0] === '--check'
const pkg = JSON.parse(read('package.json'))
const lockResult = ts.parseConfigFileTextToJson('bun.lock', read('bun.lock').toString())
if (lockResult.error) throw new Error('Cannot parse bun.lock')
const lock = lockResult.config
if (
  pkg.devDependencies.esbuild !== esbuildVersion ||
  lock.packages.esbuild?.[0] !== `esbuild@${esbuildVersion}`
) {
  throw new Error('Install the exact locked esbuild before building')
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  write: false,
  metafile: true,
  logLevel: 'silent',
  // ws documents these opt-outs. Keep its portable JS / Node buffer.isUtf8
  // implementations; never search ancestor node_modules for native addons.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  banner: {
    js: "import { createRequire as __ccscCreateRequire } from 'node:module'; const require = __ccscCreateRequire(import.meta.url);",
  },
})
if (result.warnings.length) throw new Error(JSON.stringify(result.warnings))
const externals = [
  ...new Set([
    // esbuild's metafile does not include imports inserted by the banner.
    'node:module',
    ...Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.filter((item) => item.external).map((item) => item.path),
    ),
  ]),
].sort()
for (const name of externals) {
  if (!builtinModules.includes(name.replace(/^node:/, ''))) {
    throw new Error(`Unexpected external module: ${name}`)
  }
}
const runtime = result.outputFiles[0].text.replace(/^#![^\n]*\n/, '#!/usr/bin/env node\n')
const ast = ts.createSourceFile(
  'runtime.mjs',
  runtime,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
)
function checkModuleLoads(node) {
  if (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) &&
      ['require', '__require'].includes(node.expression.text)) ||
      node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
    (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
  ) {
    throw new Error(`Nonliteral module load: ${node.getText(ast)}`)
  }
  ts.forEachChild(node, checkModuleLoads)
}
checkModuleLoads(ast)

const inputs = Object.keys(result.metafile.inputs).sort()
const packages = new Map()
for (const input of inputs) {
  if (input.startsWith('../') || input.startsWith('/'))
    throw new Error(`Input outside root: ${input}`)
  if (!input.includes('node_modules/')) continue
  const prefixEnd = input.lastIndexOf('node_modules/') + 'node_modules/'.length
  const parts = input.slice(prefixEnd).split('/')
  const packageDir =
    input.slice(0, prefixEnd) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/')
  if (packages.has(packageDir)) continue
  const manifest = JSON.parse(read(`${packageDir}/package.json`))
  const key = packageDir.replace(/^node_modules\//, '').replaceAll('/node_modules/', '/')
  const record = lock.packages[key]
  if (
    record?.[0] !== `${manifest.name}@${manifest.version}` ||
    typeof record[3] !== 'string' ||
    !record[3].startsWith('sha512-')
  ) {
    throw new Error(`Dependency does not match lock: ${key}`)
  }
  const notices = readdirSync(join(root, packageDir))
    .filter((name) => /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(name))
    .sort()
  // agent-base 6.0.2 and https-proxy-agent 5.0.1 keep full MIT grants in README.md.
  // Preserve that document verbatim, not merely the manifest's SPDX label.
  if (
    !notices.length &&
    [
      ['agent-base', '6.0.2'],
      ['https-proxy-agent', '5.0.1'],
    ].some(([name, version]) => manifest.name === name && manifest.version === version)
  ) {
    const text = read(`${packageDir}/README.md`).toString()
    if (
      !text.includes('Permission is hereby granted') ||
      !text.includes('THE SOFTWARE IS PROVIDED')
    ) {
      throw new Error(`${key} README no longer contains its full MIT notice`)
    }
    notices.push('README.md')
  }
  if (!notices.length) throw new Error(`Missing full license text: ${key}`)
  packages.set(packageDir, {
    name: manifest.name,
    version: manifest.version,
    lockKey: key,
    lockIntegrity: record[3],
    license: manifest.license,
    notices: notices.map((name) => `${packageDir}/${name}`),
  })
}
const dependencies = [...packages.values()].sort((a, b) => a.lockKey.localeCompare(b.lockKey, 'en'))
const noticePaths = [
  'LICENSE',
  'NOTICE',
  ...dependencies.flatMap((dependency) => dependency.notices),
]
const notices = noticePaths
  .map((path) => `===== ${path} =====\n${read(path).toString().trimEnd()}\n`)
  .join('\n')
const sources = [
  ...new Set([...inputs, ...noticePaths, 'package.json', 'bun.lock', 'scripts/build-runtime.mjs']),
].sort()
const provenance = {
  format: 'ccsc-runtime-v1',
  entry: 'server.ts',
  target: 'node20',
  esbuild: esbuildVersion,
  optionalNativeAddons: 'disabled via documented ws opt-outs',
  // Integrity names the lock's archive receipt; source hashes identify the
  // bytes actually consumed. This does not authenticate an existing cache.
  dependencies,
  externals,
  inputs: Object.fromEntries(sources.map((path) => [path, { sha256: sha256(read(path)) }])),
  artifacts: {
    [`${stem}.mjs`]: sha256(runtime),
    [`${stem}.LICENSES.txt`]: sha256(notices),
  },
}
const outputs = new Map([
  [`${stem}.mjs`, runtime],
  [`${stem}.LICENSES.txt`, notices],
  [`${stem}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`],
])
for (const [path, content] of outputs) {
  if (check) {
    if (!existsSync(join(root, path)) || !read(path).equals(Buffer.from(content))) {
      throw new Error(`Runtime artifact missing or stale: ${path}; run npm run build:runtime`)
    }
  } else {
    writeFileSync(join(root, path), content)
  }
}
console.log(
  `${check ? 'Verified' : 'Built'} runtime: ${inputs.length} inputs, ${dependencies.length} locked packages`,
)
