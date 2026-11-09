import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm.provider.js';

@Injectable()
export class OllamaProvider extends LlmProvider {
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config.get<string>('OLLAMA_URL') ?? 'http://localhost:11434';
    this.modelName = config.get<string>('OLLAMA_MODEL') ?? 'qwen2.5-coder:7b';
    // Ollama's default window is small (a few thousand tokens) and it cuts the rest WITHOUT an error.
    // The review now sends the full file as context, so ask for a bigger window. Lower it if memory is tight.
    const ctx = Number(config.get<string>('OLLAMA_NUM_CTX'));
    this.numCtx = Number.isFinite(ctx) && ctx > 0 ? ctx : 16384;
    // A 7B model on CPU can need several minutes per file. Raise this on slow machines.
    const timeout = Number(config.get<string>('OLLAMA_TIMEOUT_MS'));
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000;
  }

  async completeJson(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        stream: false,
        format: 'json', // ask Ollama to return valid JSON only
        options: { temperature: 0.1, num_ctx: this.numCtx }, // low = more repeatable answers
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}
