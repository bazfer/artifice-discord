import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice'
import { ChannelType, type ChatInputCommandInteraction, type Client, type VoiceBasedChannel } from 'discord.js'
import { transcribe } from './stt'
import { speak } from './tts'

const DEFAULT_FERNANDO_USER_ID = '301045022361518081'
const MIN_UTTERANCE_MS = 300
const INACTIVITY_LEAVE_MS = 10 * 60 * 1000
const VOICE_OPCODE_SPEAKING = 5

type PacketEmitter = {
  on: (event: 'packet', listener: (packet: { op?: number; d?: { user_id?: string; speaking?: number } }) => void) => void
  off: (event: 'packet', listener: (packet: { op?: number; d?: { user_id?: string; speaking?: number } }) => void) => void
}

type StateChangeEmitter = {
  state?: unknown
  on: (event: 'stateChange', listener: (oldState: unknown, newState: unknown) => void) => void
  off: (event: 'stateChange', listener: (oldState: unknown, newState: unknown) => void) => void
}

type VoiceState = {
  guildId: string
  voiceChannelId: string
  textChannelId: string
  connection: VoiceConnection
  speaking: boolean
  utteranceStartedAt: number
  chunks: Buffer[]
  stream?: NodeJS.ReadableStream & { destroy?: () => void }
  voiceGatewayCleanup?: () => void
  inactivityTimer?: ReturnType<typeof setTimeout>
}

type VoiceManagerOptions = {
  client: Client
  targetUserId?: string
  onTranscript: (args: { text: string; chatId: string; guildId: string; voiceChannelId: string }) => void | Promise<void>
}

export class VoiceManager {
  private client: Client
  private targetUserId: string
  private onTranscript: VoiceManagerOptions['onTranscript']
  private states = new Map<string, VoiceState>()

  constructor(opts: VoiceManagerOptions) {
    this.client = opts.client
    this.targetUserId = opts.targetUserId ?? process.env.DISCORD_VOICE_USER_ID ?? DEFAULT_FERNANDO_USER_ID
    this.onTranscript = opts.onTranscript
  }

  async joinFromInteraction(interaction: ChatInputCommandInteraction): Promise<string> {
    if (!interaction.guild) throw new Error('/voice join only works in a server')

    const member = await interaction.guild.members.fetch(this.targetUserId)
    const voiceChannel = member.voice.channel
    if (!voiceChannel) throw new Error('Fernando is not currently in a voice channel in this server')
    if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
      throw new Error('Fernando is not in a joinable voice channel')
    }

    await this.join(voiceChannel, interaction.channelId)
    return `Joined ${voiceChannel.name}.`
  }

  async join(voiceChannel: VoiceBasedChannel, textChannelId: string): Promise<void> {
    const guildId = voiceChannel.guild.id
    const existing = this.states.get(guildId)
    if (existing) this.leave(guildId)

    const me = voiceChannel.guild.members.me ?? await voiceChannel.guild.members.fetchMe()
    const perms = voiceChannel.permissionsFor(me)
    if (!perms?.has('Connect') || !perms?.has('Speak')) {
      throw new Error(`missing voice perms in #${voiceChannel.name} (need Connect + Speak)`)
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
    } catch (err) {
      connection.destroy()
      throw new Error(`voice connection never became ready: ${err instanceof Error ? err.message : String(err)}`)
    }

    const state: VoiceState = {
      guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId,
      connection,
      speaking: false,
      utteranceStartedAt: 0,
      chunks: [],
    }
    this.states.set(guildId, state)
    this.resetInactivityTimer(state)
    this.wireReceiver(state)
    this.wireVoiceGatewaySpeaking(state)

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ])
      } catch {
        if (this.states.get(guildId) === state) this.leave(guildId)
      }
    })
  }

  leave(guildId?: string): string {
    const targetGuildId = guildId ?? (this.states.size === 1 ? [...this.states.keys()][0] : undefined)
    if (!targetGuildId) return this.states.size === 0 ? 'Not connected to voice.' : 'Connected in multiple guilds; specify guild.'
    const state = this.states.get(targetGuildId)
    if (!state) return 'Not connected to voice.'

    if (state.inactivityTimer) clearTimeout(state.inactivityTimer)
    try { state.voiceGatewayCleanup?.() } catch {}
    try { state.stream?.destroy?.() } catch {}
    try { state.connection.destroy() } catch {}
    this.states.delete(targetGuildId)
    return 'Left voice.'
  }

  async speakForChat(chatId: string, text: string): Promise<void> {
    const state = [...this.states.values()].find(s => s.textChannelId === chatId)
    if (!state || !text.trim()) return
    this.resetInactivityTimer(state)
    try {
      await speak(text, state.connection)
    } catch (err) {
      process.stderr.write(`artifice-discord: voice TTS failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  shutdown(): void {
    for (const guildId of [...this.states.keys()]) this.leave(guildId)
  }

  private wireReceiver(state: VoiceState): void {
    const receiver = state.connection.receiver

    receiver.speaking.on('start', userId => {
      if (userId !== this.targetUserId || this.states.get(state.guildId) !== state) return
      this.resetInactivityTimer(state)

      // receiver.speaking is packet-inactivity based. Use it only to start
      // packet buffering; the utterance is flushed by the voice gateway
      // Speaking opcode when Discord reports the user's bitfield dropped to 0.
      if (state.speaking && state.stream) return

      state.speaking = true
      state.utteranceStartedAt = Date.now()
      state.chunks = []
      try { state.stream?.destroy?.() } catch {}

      const stream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      })
      state.stream = stream
      stream.on('data', (chunk: Buffer) => {
        if (state.speaking) {
          this.resetInactivityTimer(state)
          state.chunks.push(Buffer.from(chunk))
        }
      })
      stream.on('error', err => {
        process.stderr.write(`artifice-discord: voice receive stream failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    })
  }

  private wireVoiceGatewaySpeaking(state: VoiceState): void {
    const boundNetworkings = new WeakSet<object>()
    const boundWebSockets = new WeakSet<object>()
    const cleanup: Array<() => void> = []

    const onPacket = (packet: { op?: number; d?: { user_id?: string; speaking?: number } }) => {
      if (this.states.get(state.guildId) !== state) return
      if (packet.op !== VOICE_OPCODE_SPEAKING) return
      if (packet.d?.user_id !== this.targetUserId) return

      this.resetInactivityTimer(state)
      if (packet.d.speaking === 0) void this.flushUtterance(state)
    }

    const bindWs = (networkingState: unknown) => {
      const ws = (networkingState as { ws?: PacketEmitter } | undefined)?.ws
      if (!ws || boundWebSockets.has(ws)) return
      boundWebSockets.add(ws)
      ws.on('packet', onPacket)
      cleanup.push(() => ws.off('packet', onPacket))
    }

    const bindNetworking = (networking: unknown) => {
      const target = networking as StateChangeEmitter | undefined
      if (!target || boundNetworkings.has(target)) return
      boundNetworkings.add(target)

      const onNetworkingStateChange = (_oldState: unknown, newState: unknown) => bindWs(newState)
      target.on('stateChange', onNetworkingStateChange)
      cleanup.push(() => target.off('stateChange', onNetworkingStateChange))
      bindWs(target.state)
    }

    const onConnectionStateChange = (_oldState: unknown, newState: unknown) => {
      bindNetworking((newState as { networking?: unknown }).networking)
    }

    state.connection.on('stateChange', onConnectionStateChange)
    cleanup.push(() => state.connection.off('stateChange', onConnectionStateChange))
    bindNetworking((state.connection.state as { networking?: unknown }).networking)

    state.voiceGatewayCleanup = () => {
      for (const dispose of cleanup.splice(0)) dispose()
    }
  }

  private async flushUtterance(state: VoiceState): Promise<void> {
    if (!state.speaking) return
    state.speaking = false
    this.resetInactivityTimer(state)

    const elapsed = Date.now() - state.utteranceStartedAt
    const chunks = state.chunks
    state.chunks = []
    try { state.stream?.destroy?.() } catch {}
    state.stream = undefined

    if (elapsed < MIN_UTTERANCE_MS || chunks.length === 0) return

    const framedOpus = Buffer.concat(chunks.flatMap(chunk => {
      const len = Buffer.allocUnsafe(4)
      len.writeUInt32BE(chunk.length, 0)
      return [len, chunk]
    }))
    const text = (await transcribe(framedOpus)).trim()
    if (!text || this.states.get(state.guildId) !== state) return

    await this.onTranscript({
      text,
      chatId: state.textChannelId,
      guildId: state.guildId,
      voiceChannelId: state.voiceChannelId,
    })
  }

  private resetInactivityTimer(state: VoiceState): void {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer)
    state.inactivityTimer = setTimeout(() => {
      if (this.states.get(state.guildId) !== state) return
      if (state.speaking) {
        this.resetInactivityTimer(state)
        return
      }
      process.stderr.write(`artifice-discord: auto-leaving voice after ${INACTIVITY_LEAVE_MS / 60000} minutes idle\n`)
      this.leave(state.guildId)
    }, INACTIVITY_LEAVE_MS)
    state.inactivityTimer.unref?.()
  }
}
