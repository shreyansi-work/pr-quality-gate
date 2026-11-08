import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DevController } from './dev/dev.controller.js';
import { ApiController } from './gate/api.controller.js';
import { GateService } from './gate/gate.service.js';
import { RecheckService } from './gate/recheck.service.js';
import { TriageService } from './gate/triage.service.js';
import { GithubService } from './github/github.service.js';
import { HealthController } from './health.controller.js';
import { GroqProvider } from './llm/groq.provider.js';
import { LlmProvider } from './llm/llm.provider.js';
import { OllamaProvider } from './llm/ollama.provider.js';
import { PrismaService } from './prisma.service.js';
import { ReviewQueueService } from './review/review-queue.service.js';
import { ReviewService } from './review/review.service.js';
import { ReviewWorker } from './review/review.worker.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, WebhooksController, DevController, ApiController],
  providers: [
    PrismaService,
    WebhooksService,
    GithubService,
    ReviewQueueService,
    ReviewService,
    ReviewWorker,
    GateService,
    RecheckService,
    TriageService,
    // Anything that asks for LlmProvider gets the one chosen by LLM_PROVIDER in .env ("ollama" by default, or "groq").
    {
      provide: LlmProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LlmProvider =>
        config.get<string>('LLM_PROVIDER') === 'groq' ? new GroqProvider(config) : new OllamaProvider(config),
    },
  ],
})
export class AppModule {}
