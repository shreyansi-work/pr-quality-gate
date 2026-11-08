import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Locks /api behind one shared token when API_TOKEN is set (set it on any server
 * that is reachable from the internet). With no token set (local dev) it lets everything in.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('API_TOKEN');
    if (!expected) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const given = req.header('x-api-token') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Bad or missing API token');
    return true;
  }
}
