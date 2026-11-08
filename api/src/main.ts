import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // A public server without a token would show every pull request and finding to anyone.
  if (process.env.NODE_ENV === 'production' && !process.env.API_TOKEN) {
    throw new Error('API_TOKEN is required when NODE_ENV=production. Set it in the server environment.');
  }
  // rawBody: keep the exact bytes of each request, needed to verify GitHub's signature.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Lets /dev/review accept a plain-text `git diff`.
  app.useBodyParser('text', { limit: '5mb' });
  // GitHub sends up to 25 MB; the default of 100 KB would reject a pull request with a long description.
  app.useBodyParser('json', { limit: '25mb' });
  // The web UI: plain files in api/public (run the server from the api/ folder).
  app.useStaticAssets(join(process.cwd(), 'public'));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
