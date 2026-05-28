# artifice-discord — unified Discord channel plugin + tool-usage streaming

## Goal
Own the entire Discord pipe in one MCP plugin (inbound + outbound), retire
Anthropic's `discord@claude-plugins-official`, and stream live tool usage into
the channel — mirroring the covyeng Mattermost architecture.

## Background / why we fork the official plugin
- Two candidate bases existed:
  - An old minimal gateway server (~143 lines, removed because its gateway
    fought the official plugin for the DeetBot token — that was the outage).
  - The **official plugin** (`anthropics/claude-plugins-official` →
    `external_plugins/discord`, ~900 lines of clean, forkable TypeScript).
    Superset of everything we have.
- Decision: **fork the official plugin.** It already ships gateway + intents +
  DM partials, full access control (pairing/allowlist/group policies/mention-
  trigger), permission relay (buttons + "yes xxxxx" text replies), and tools
  `reply` (chunking/threading/file attach), `react`, `edit_message`,
  `download_attachment`, `fetch_messages`, plus security hardening.
- The fork **replaces both** the official plugin *and* the old REST-only
  `artifice-discord-streaming` (superset of its outbound tools). One plugin owns
  the whole pipe.
- The unified design is proven. The open problem is the **token conflict**,
  solved by an atomic cutover, not by clever code.

## What the fork buys us (and what it doesn't)
- Buys: ownership, freedom to customize routing/chunking/fleet behavior, and a
  home for the `post_update` rolling working-message feature.
- Does NOT buy: tool-usage streaming for free. Tool calls happen inside the live
  session; even our own plugin can't observe them. Tool-streaming stays a
  PreToolUse hook (Phase 4) regardless of who owns inbound.

## The one hard constraint
Discord allows exactly **one gateway connection per bot token per shard**. The
instant this plugin opens a gateway, it collides with the official plugin on the
same token. Therefore: **artifice-discord ON and the official plugin OFF must
happen in the same restart.** No overlap window, ever. Standalone testing uses a
separate *test* bot token to avoid touching the live connection.

---

## Phase 0 — Prep & decisions
- [ ] Confirm `MESSAGE_CONTENT` privileged intent enabled in the Discord dev
      portal for DeetBot (the official plugin uses it, so likely already on).
- [ ] Register a throwaway **test bot** + private test channel in the guild.
      Separate token = no conflict with the live DeetBot gateway.
- [ ] Lock the channel allowlist (#deet + fleet channels we actually listen on).

## Phase 1 — Fork the official plugin  ✅ (landed)
- [x] Fork `anthropics/claude-plugins-official` on GitHub as `bazfer/artifice-discord`.
- [x] Gut the monorepo down to just the discord plugin, promoted to repo root.
- [x] Rebrand identity: plugin name, MCP server name (`.mcp.json`),
      package name, MCP `Server({ name })`, skill namespace (`/artifice-discord:*`),
      and log prefixes — all `artifice-discord`.
- [x] Keep state dir `~/.claude/channels/discord/` so the fork inherits the
      existing channel allowlist at cutover; test isolation via `DISCORD_STATE_DIR`.
- [ ] Port the `post_update` auto-tracked working-message tool into the fork
      (the official one only has `edit_message`, which needs a message_id).

## Phase 2 — Standalone validation (test bot, zero risk)
- [ ] Run the plugin with the **test** token against the test channel
      (`DISCORD_STATE_DIR` pointed at a throwaway dir).
- [ ] Prove end-to-end: message in test channel → notification → live session
      sees it → `reply` lands in the test channel.
- [ ] Force-disconnect the WS; confirm discord.js auto-reconnects (RESUME).
- [ ] Live DeetBot + official plugin untouched throughout this phase.

## Phase 3 — Atomic cutover
- [ ] Swap test token → real DeetBot token; real allowlist.
- [ ] Single restart: `artifice-discord` ON **and** the official plugin OFF.
- [ ] Verify: inbound routes, replies land, no gateway flapping for 10 min.
- [ ] Rollback (documented): re-enable official plugin, disable ours.

## Phase 4 — Tool-usage streaming hook
- [ ] PreToolUse hook posts a one-line tool activity (`🔧 Read user.rb`) to the
      active channel.
- [ ] Channel bridge: the plugin writes the last-active `chat_id` to a state
      file on every `reply`/`post_update`; the hook reads it.
- [ ] Render as a rolling activity message via silent edit (no ping spam),
      throttled so a Bash-heavy turn doesn't flood the channel.
- [ ] Optional PostToolUse for completion/duration.

## Phase 5 — Harden & roll out
- [ ] Reconnect/RESUME tested under forced disconnect.
- [ ] REST rate-limit handling (429 backoff).
- [ ] Optional: port to Luna and Kat.

---

## Acceptance criteria
- A message in an allowlisted Discord channel reaches the live session with no
  official plugin enabled.
- Replies, progress edits, and history fetch all work via the single plugin.
- Gateway survives a forced disconnect (auto-RESUME) without manual restart.
- Tool calls appear in the channel as a throttled, non-pinging activity feed.
- Rollback path restores service in one restart if the cutover misbehaves.

## Prior art
- Voice extension reference (for a later phase): `Stannaz/claude-plugins-burg`
  added `voice.ts`/`stt.ts`/`presence.ts` to this plugin.
