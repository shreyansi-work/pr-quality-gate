import { CanActivate, ExecutionContext, Injectable, RawBodyRequest, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class GithubSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const signature = req.headers['x-hub-signature-256'];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret || typeof signature !== 'string' || !req.rawBody) {
      throw new UnauthorizedException('Missing signature');
    }
    const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid signature');
    }
    return true;
  }
}
