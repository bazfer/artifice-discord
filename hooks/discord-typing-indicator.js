#!/usr/bin/env node
// persona-typing-indicator.js — PreToolUse hook (no matcher).
// Fires before every tool call, sends a typing indicator to the bot's Discord channel.
// Channel is read from persona.md frontmatter (discord_channel field).

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const personaPath = path.join(claudeDir, 'persona.md');
const tokenFile = path.join(claudeDir, 'discord-token');

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

let persona = {};
try { persona = readFrontmatter(fs.readFileSync(personaPath, 'utf8')); } catch {}

const channel = persona.discord_channel || '';
if (!channel) { process.exit(0); }

let token = '';
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!token) { process.exit(0); }

const req = https.request({
  hostname: 'discord.com',
  path: `/api/v10/channels/${channel}/typing`,
  method: 'POST',
  headers: {
    'Authorization': `Bot ${token}`,
    'Content-Length': '0',
  }
});
req.on('error', () => {});
req.end();

// Fire-and-forget — don't wait for response
setTimeout(() => process.exit(0), 100);
