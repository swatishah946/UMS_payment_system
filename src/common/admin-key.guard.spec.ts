import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminKeyGuard } from './admin-key.guard';

const contextWith = (key?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ header: (name: string) => (name === 'x-admin-key' ? key : undefined) }),
    }),
  }) as unknown as ExecutionContext;

const guardWith = (adminApiKey: string) => new AdminKeyGuard(new ConfigService({ adminApiKey }));

describe('AdminKeyGuard', () => {
  it('lets everything through when no admin key is configured', () => {
    expect(guardWith('').canActivate(contextWith())).toBe(true);
  });

  it('accepts the correct key', () => {
    expect(guardWith('secret').canActivate(contextWith('secret'))).toBe(true);
  });

  it('rejects a missing or wrong key', () => {
    expect(() => guardWith('secret').canActivate(contextWith())).toThrow(UnauthorizedException);
    expect(() => guardWith('secret').canActivate(contextWith('nope'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guardWith('secret').canActivate(contextWith('secret2'))).toThrow(
      UnauthorizedException,
    );
  });
});
