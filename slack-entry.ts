#!/usr/bin/env -S npx tsx
/**
 * slack-entry — plugin MCP entry point. Selects the channel server mode:
 *
 *   • SLACK_MULTISESSION=1  → slack-session.ts (multi-session client; registers
 *                             with a running slack-router that owns the socket)
 *   • otherwise (default)   → server.ts (the original single-session monolith,
 *                             unchanged behavior)
 *
 * Keeping one entry point means the plugin's .mcp.json never changes; opting
 * into multi-session is a per-session environment flag. See
 * docs/multi-session-routing.md.
 */

if (process.env.SLACK_MULTISESSION === '1') {
  await import('./slack-session.ts')
} else {
  await import('./server.ts')
}
