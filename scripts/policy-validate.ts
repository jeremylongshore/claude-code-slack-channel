#!/usr/bin/env bun
// Policy-rule validator used by the `/slack-channel:policy` skill. Thin wrapper
// around the real loaders in policy.ts so the skill can surface parse errors,
// shadow warnings, and broad-auto-approve warnings BEFORE the operator writes
// access.json and restarts the server.
//
// Usage:
//   bun scripts/policy-validate.ts <path-to-access.json>
//   bun scripts/policy-validate.ts --rules <path-to-rules.json>   (bare array)
//   bun scripts/policy-validate.ts --stdin                         (bare array on stdin)
//
// Exit codes:
//   0 — parse OK (warnings printed to stderr; --json output on stdout)
//   1 — parse failure (Zod error or duplicate id) or bad CLI args
//
// stdout shape (always valid JSON):
//   { "ok": true,  "count": N, "shadows": [...], "broads": [...], "duplicates": [] }
//   { "ok": false, "error": "<message>" }

import { readFileSync } from 'node:fs'
import {
  detectBroadAutoApprove,
  detectShadowing,
  type PolicyRule,
  parsePolicyRules,
} from '../policy.ts'

function die(msg: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  process.exit(1)
}

function readInput(): { source: string; raw: unknown } {
  const args = process.argv.slice(2)
  if (args.length === 0) die('usage: policy-validate.ts <access.json> | --rules <file> | --stdin')

  if (args[0] === '--stdin') {
    const body = readFileSync(0, 'utf8')
    try {
      return { source: '<stdin>', raw: JSON.parse(body) }
    } catch (err) {
      die(`invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (args[0] === '--rules') {
    if (!args[1]) die('--rules requires a path argument')
    try {
      return { source: args[1]!, raw: JSON.parse(readFileSync(args[1]!, 'utf8')) }
    } catch (err) {
      die(`cannot read ${args[1]}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Default: treat arg as access.json and pull its `policy` field.
  try {
    const body = JSON.parse(readFileSync(args[0]!, 'utf8')) as Record<string, unknown>
    return { source: args[0]!, raw: body.policy ?? [] }
  } catch (err) {
    die(`cannot read ${args[0]}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Duplicate-id check — ACCESS.md §"Safety checks" promises this is fatal at
// boot but server.ts doesn't actually enforce it today (ccsc-kx8). Do it here
// so the skill catches the mismatch before the operator writes.
function findDuplicateIds(rules: readonly PolicyRule[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) dupes.add(rule.id)
    seen.add(rule.id)
  }
  return [...dupes]
}

const { source, raw } = readInput()

let parsed: PolicyRule[]
try {
  parsed = parsePolicyRules(raw)
} catch (err) {
  die(`parse failed for ${source}: ${err instanceof Error ? err.message : String(err)}`)
}

const duplicates = findDuplicateIds(parsed)
if (duplicates.length > 0) {
  die(`duplicate rule id(s) in ${source}: ${duplicates.join(', ')}`)
}

const shadows = detectShadowing(parsed)
const broads = detectBroadAutoApprove(parsed)

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    source,
    count: parsed.length,
    shadows: shadows.map((w) => ({ later: w.later, earlier: w.earlier, message: w.message })),
    broads: broads.map((w) => ({ ruleId: w.ruleId, message: w.message })),
  })}\n`,
)
