import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm.provider.js';

/**
 * Groq runs large open models in the cloud. It speaks the OpenAI-style chat API.
 * Privacy: the diff leaves your machine and goes to Groq. Use it for test or public code
 * unless your company allows it.
 */
@Injectable()
export class GroqProvider extends LlmProvider {
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log = new Logger(GroqProvider.name);

  constructor(config: ConfigService) {
    super();
    const key = config.get<string>('GROQ_API_KEY');
    if (!key) throw new Error('LLM_PROVIDER=groq needs GROQ_API_KEY in .env');
    this.apiKey = key;
    this.baseUrl = config.get<string>('GROQ_URL') ?? 'https://api.groq.com/openai/v1';
    this.modelName = config.get<string>('GROQ_MODEL') ?? 'llama-3.3-70b-versatile';
  }

  async completeJson(system: string, user: string): Promise<string> {
    // Free plans have per-minute limits. On a 429 we wait once and try again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.modelName,
          temperature: 0.1, // low = more repeatable answers
          response_format: { type: 'json_object' }, // the prompts already say "JSON only"
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 30);
        this.log.warn(`Groq rate limit, waiting ${wait}s and retrying once`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Groq ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    }
    throw new Error('Groq: unreachable');
  }
}
