import { TextToSpeechClient } from '@google-cloud/text-to-speech'
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
} from '@discordjs/voice'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

const DEFAULT_VOICE = 'en-US-Neural2-D'
let ttsClient: TextToSpeechClient | null = null

function getTtsClient(): TextToSpeechClient {
  if (!ttsClient) ttsClient = new TextToSpeechClient()
  return ttsClient
}

export function readTtsVoice(): string {
  try {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const content = readFileSync(join(claudeDir, 'persona.md'), 'utf8')
    const m = content.match(/^tts_voice:\s*"?([^"\n]+)"?\s*$/m)
    return m?.[1]?.trim() || DEFAULT_VOICE
  } catch {
    return DEFAULT_VOICE
  }
}

// Best-effort experimental fallback for GOOGLE_API_KEY; ADC/service-account auth is the supported path.
async function synthesizeWithApiKey(text: string, voiceName: string, apiKey: string): Promise<Buffer> {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voiceName.split('-').slice(0, 2).join('-'), name: voiceName },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google TTS HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as { audioContent?: string }
  if (!json.audioContent) throw new Error('Google TTS response did not include audioContent')
  return Buffer.from(json.audioContent, 'base64')
}

export async function synthesize(text: string, voiceName = readTtsVoice()): Promise<Buffer> {
  if (process.env.GOOGLE_API_KEY) {
    return synthesizeWithApiKey(text, voiceName, process.env.GOOGLE_API_KEY)
  }

  const [response] = await getTtsClient().synthesizeSpeech({
    input: { text },
    voice: { languageCode: voiceName.split('-').slice(0, 2).join('-'), name: voiceName },
    audioConfig: { audioEncoding: 'MP3' },
  })

  if (!response.audioContent) throw new Error('Google TTS response did not include audioContent')
  return Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent as Uint8Array)
}

export async function speak(text: string, connection: VoiceConnection, voiceName = readTtsVoice()): Promise<void> {
  const mp3 = await synthesize(text, voiceName)
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } })
  const resource = createAudioResource(Readable.from(mp3), { inputType: StreamType.Arbitrary })
  connection.subscribe(player)
  player.play(resource)
  await entersState(player, AudioPlayerStatus.Idle, 120_000)
}
