#!/usr/bin/env node
// discord-stop-forward.js — Stop hook
// Safety net for Discord-bridged bots: when a turn was triggered by a Discord
// message but ended WITHOUT calling the reply tool, the agent's closing text
// only reached the terminal — invisible to the user. This forwards that text
// to the originating Discord channel so no response silently vanishes.
//
// Fires on Stop. Does nothing (exit 0) when: the turn already called reply, the
// trigger wasn't a Discord message, or there's no closing text. Never blocks.

const { readFileSync } = require('fs')
const { request } = require('https')
const { join } = require('path')
const { homedir } = require('os')

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const personaPath = join(claudeDir, 'persona.md')
const tokenFile = join(claudeDir, 'discord-token')

const REPLY_TOOL = 'mcp__plugin_artifice-discord_artifice-discord__reply'
const DISCORD_SOURCE = 'source="plugin:artifice-discord:artifice-discord"'

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/)
    if (m) result[m[1]] = m[2].trim()
  }
  return result
}

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim()
  }
  return ''
}

function isToolResult(content) {
  return Array.isArray(content) && content.length > 0 &&
    content.every(b => b && b.type === 'tool_result')
}

function hasReplyCall(content) {
  return Array.isArray(content) && content.some(b => b && b.type === 'tool_use' && b.name === REPLY_TOOL)
}

let raw = ''
process.stdin.on('data', c => { raw += c })
process.stdin.on('end', () => {
  let payload = {}
  try { payload = JSON.parse(raw) } catch { process.exit(0) }

  // We never block, so a re-prompt loop can't form — but bail anyway if flagged.
  if (payload.stop_hook_active) process.exit(0)

  const transcriptPath = payload.transcript_path
  if (!transcriptPath) process.exit(0)

  let entries
  try {
    entries = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { process.exit(0) }
  if (entries.length === 0) process.exit(0)

  // Walk backwards through the current turn: capture the final assistant text,
  // note any reply call, and find the triggering user message. tool_result
  // user entries and non-message bookkeeping entries are intra-turn — skip them.
  let finalText = ''
  let repliedThisTurn = false
  let triggerContent = null

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    const content = e.message && e.message.content
    if (e.type === 'assistant') {
      if (hasReplyCall(content)) repliedThisTurn = true
      if (!finalText) finalText = textOf(content)
    } else if (e.type === 'user') {
      if (isToolResult(content)) continue
      triggerContent = textOf(content)
      break
    }
  }

  if (repliedThisTurn) process.exit(0)
  if (!finalText) process.exit(0)
  if (!triggerContent || !triggerContent.includes(DISCORD_SOURCE)) process.exit(0)

  let persona = {}
  try { persona = readFrontmatter(readFileSync(personaPath, 'utf8')) } catch {}
  const chatMatch = triggerContent.match(/chat_id="(\d+)"/)
  const channel = (chatMatch && chatMatch[1]) || persona.discord_channel || ''
  if (!channel) process.exit(0)

  let token = ''
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch {}
  if (!token) process.exit(0)

  // Discord hard-caps messages at 2000 chars — chunk on newline boundaries.
  const chunks = []
  let rest = finalText
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n', 2000)
    if (cut < 1000) cut = 2000
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)

  function post(idx) {
    if (idx >= chunks.length) { process.exit(0); return }
    const body = JSON.stringify({ content: chunks[idx] })
    const req = request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channel}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      res.on('data', () => {})
      res.on('end', () => post(idx + 1))
    })
    req.on('error', () => process.exit(0))
    req.write(body)
    req.end()
  }
  post(0)

  setTimeout(() => process.exit(0), 5000)
})
