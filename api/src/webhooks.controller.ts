import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { GithubSignatureGuard } from './github-signature.guard.js';
import { WebhooksService, type PullRequestEvent } from './webhooks.service.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('github')
  @HttpCode(200)
  @UseGuards(GithubSignatureGuard)
  async github(@Headers('x-github-event') event: string, @Body() payload: PullRequestEvent) {
    if (event === 'ping') return { ok: true, ping: true };
    if (event !== 'pull_request') return { ok: true, ignored: event };
    await this.webhooks.handlePullRequest(payload);
    return { ok: true };
  }
}
