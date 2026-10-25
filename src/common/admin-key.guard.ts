import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Protects admin-only routes (cancel, reconcile) with an `x-admin-key` header.
 *
 * Login itself belongs to the ERP; this is the minimum so a public demo deployment
 * can't be used by anyone to cancel orders. Turned off when ADMIN_API_KEY is not set,
 * so local setup works without extra config.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('adminApiKey');
    if (!expected) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const given = req.header('x-admin-key') ?? '';

    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({
        code: 'ADMIN_KEY_REQUIRED',
        message: 'This action needs a valid x-admin-key header',
      });
    }
    return true;
  }
}
