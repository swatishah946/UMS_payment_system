import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { CashfreeApiError, CashfreeService } from './cashfree.service';

const SECRET = 'test_secret';

function makeService() {
  const config = new ConfigService({
    cashfree: { appId: 'app', secretKey: SECRET, env: 'sandbox', apiVersion: '2026-01-01' },
  });
  return new CashfreeService(config);
}

const sign = (ts: string, body: string, secret = SECRET) =>
  createHmac('sha256', secret)
    .update(ts + body)
    .digest('base64');

describe('CashfreeService.verifyWebhookSignature', () => {
  const service = makeService();
  const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}';
  const ts = '1729765200000';

  it('accepts a correctly signed body', () => {
    expect(service.verifyWebhookSignature(body, ts, sign(ts, body))).toBe(true);
  });

  it('rejects when body was changed', () => {
    expect(service.verifyWebhookSignature(body + ' ', ts, sign(ts, body))).toBe(false);
  });

  it('rejects when timestamp was changed', () => {
    expect(service.verifyWebhookSignature(body, '1', sign(ts, body))).toBe(false);
  });

  it('rejects signature made with another secret', () => {
    expect(service.verifyWebhookSignature(body, ts, sign(ts, body, 'other'))).toBe(false);
  });

  it('rejects missing values and garbage without throwing', () => {
    expect(service.verifyWebhookSignature(body, ts, '')).toBe(false);
    expect(service.verifyWebhookSignature(body, '', sign(ts, body))).toBe(false);
    expect(service.verifyWebhookSignature(body, ts, 'abc')).toBe(false);
  });
});

describe('CashfreeApiError.retryable', () => {
  it('retries network errors, 5xx and 429 only', () => {
    expect(new CashfreeApiError('timeout').retryable).toBe(true);
    expect(new CashfreeApiError('down', 503).retryable).toBe(true);
    expect(new CashfreeApiError('slow down', 429).retryable).toBe(true);
    expect(new CashfreeApiError('bad request', 400).retryable).toBe(false);
    expect(new CashfreeApiError('auth', 401).retryable).toBe(false);
  });
});
