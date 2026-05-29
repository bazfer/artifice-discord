import { SpeechClient } from '@google-cloud/speech'
import prism from 'prism-media'
import { Readable } from 'stream'

let speechClient: SpeechClient | null = null

function getSpeechClient(): SpeechClient {
  if (!speechClient) speechClient = new SpeechClient()
  return speechClient
}

function splitFramedOpusPackets(opusBuffer: Buffer): Buffer[] {
  const packets: Buffer[] = []
  let offset = 0
  while (offset + 4 <= opusBuffer.length) {
    const len = opusBuffer.readUInt32BE(offset)
    offset += 4
    if (len === 0 || offset + len > opusBuffer.length) return [opusBuffer]
    packets.push(opusBuffer.subarray(offset, offset + len))
    offset += len
  }
  return offset === opusBuffer.length && packets.length > 0 ? packets : [opusBuffer]
}

async function decodeOpusToPcm(opusBuffer: Buffer): Promise<Buffer> {
  if (opusBuffer.length === 0) return Buffer.alloc(0)

  return await new Promise<Buffer>((resolve, reject) => {
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
    const chunks: Buffer[] = []

    decoder.on('data', (chunk: Buffer) => chunks.push(chunk))
    decoder.on('end', () => resolve(Buffer.concat(chunks)))
    decoder.on('error', reject)

    const input = Readable.from(splitFramedOpusPackets(opusBuffer))
    input.on('error', reject)
    input.pipe(decoder)
  })
}

// Best-effort experimental fallback for GOOGLE_API_KEY; ADC/service-account auth is the supported path.
async function transcribeWithApiKey(pcm: Buffer, apiKey: string): Promise<string> {
  const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 48000,
        audioChannelCount: 2,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
      },
      audio: { content: pcm.toString('base64') },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google STT HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }>
  }
  return (json.results ?? [])
    .map(r => r.alternatives?.[0]?.transcript?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim()
}

async function transcribeWithCredentials(pcm: Buffer): Promise<string> {
  const [response] = await getSpeechClient().recognize({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 48000,
      audioChannelCount: 2,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
    },
    audio: { content: pcm.toString('base64') },
  })

  return (response.results ?? [])
    .map(r => r.alternatives?.[0]?.transcript?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim()
}

export async function transcribe(opusBuffer: Buffer): Promise<string> {
  try {
    const pcm = await decodeOpusToPcm(opusBuffer)
    if (pcm.length === 0) return ''
    if (process.env.GOOGLE_API_KEY) return await transcribeWithApiKey(pcm, process.env.GOOGLE_API_KEY)
    return await transcribeWithCredentials(pcm)
  } catch (err) {
    process.stderr.write(`artifice-discord: voice STT failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return ''
  }
}
