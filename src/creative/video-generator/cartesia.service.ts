import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const CARTESIA_API_BASE = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2024-06-10';
// Verified against a real call this session — 'sonic-2' (an earlier default
// guess) is sunsetted and returns 400. sonic-3/sonic-turbo are the current
// working models; sonic-3 is used as the default (higher quality).
const DEFAULT_MODEL = 'sonic-3';

/**
 * Wraps Cartesia's TTS REST API (`/tts/bytes`) for narration audio.
 *
 * Hindi pronunciation note (verified via live A/B test this session):
 * Cartesia's Hindi voices sound noticeably better fed proper Devanagari
 * script than Hinglish/Latin-transliterated text — "Nadi" romanized is
 * ambiguous (नदी vs नाड़ी), so callers writing narration scripts for a Hindi
 * voice should write the script in Devanagari, not the Hinglish convention
 * used elsewhere in this codebase for on-screen text overlays (that
 * convention exists for a different reason — image-render glyph reliability,
 * not narration pronunciation).
 */
@Injectable()
export class CartesiaService {
  private readonly logger = new Logger(CartesiaService.name);

  constructor(private readonly configService: ConfigService) {}

  /** Synthesizes speech and returns the raw WAV audio buffer. */
  async synthesizeSpeech(text: string, voiceId?: string, modelId: string = DEFAULT_MODEL): Promise<Buffer> {
    const apiKey = this.configService.get<string>('cartesia.apiKey');
    if (!apiKey) throw new Error('CARTESIA_API_KEY not configured');
    const voice = voiceId ?? this.configService.get<string>('cartesia.hindiVoiceId');
    if (!voice) throw new Error('No Cartesia voice id configured or provided');

    this.logger.log(`Calling Cartesia TTS: model=${modelId} voice=${voice} chars=${text.length}`);

    try {
      const response = await axios.post(
        `${CARTESIA_API_BASE}/tts/bytes`,
        {
          model_id: modelId,
          transcript: text,
          voice: { mode: 'id', id: voice },
          output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
          language: 'hi',
        },
        {
          headers: {
            'X-API-Key': apiKey,
            'Cartesia-Version': CARTESIA_VERSION,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
          timeout: 60000,
        },
      );
      this.logger.log(`Cartesia TTS succeeded: bytes=${response.data.length}`);
      return Buffer.from(response.data);
    } catch (err: any) {
      // Cartesia returns plain-text error bodies (not JSON) on failure —
      // axios with responseType 'arraybuffer' needs an explicit decode.
      const detail = err.response?.data ? Buffer.from(err.response.data).toString('utf-8') : err.message;
      throw new Error(`Cartesia TTS error${err.response?.status ? ` ${err.response.status}` : ''}: ${detail}`);
    }
  }
}
