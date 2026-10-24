import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import { CfCreateOrderRequest, CfOrder, CfPayment } from './cashfree.types';

export class CashfreeApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly code?: string,
  ) {
    super(message);
  }

  // network errors, 5xx and rate limits are worth retrying, 4xx are our fault
  get retryable() {
    return !this.httpStatus || this.httpStatus >= 500 || this.httpStatus === 429;
  }
}

const MAX_ATTEMPTS = 3;

@Injectable()
export class CashfreeService {
  private readonly logger = new Logger(CashfreeService.name);
  private readonly http: AxiosInstance;
  private readonly secretKey: string;

  constructor(config: ConfigService) {
    const cf = config.get('cashfree');
    this.secretKey = cf.secretKey;

    const baseURL =
      cf.env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

    this.http = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'x-client-id': cf.appId,
        'x-client-secret': cf.secretKey,
        'x-api-version': cf.apiVersion,
        'Content-Type': 'application/json',
      },
    });

    if (!cf.appId || !cf.secretKey) {
      this.logger.warn('CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set, cashfree calls will fail');
    }
  }

  // idempotencyKey must be a uuid, cashfree uses it to avoid creating the order twice on retries
  createOrder(body: CfCreateOrderRequest, idempotencyKey: string) {
    return this.request<CfOrder>({
      method: 'POST',
      url: '/orders',
      data: body,
      headers: { 'x-idempotency-key': idempotencyKey },
    });
  }

  getOrder(orderId: string) {
    return this.request<CfOrder>({ method: 'GET', url: `/orders/${encodeURIComponent(orderId)}` });
  }

  getPayments(orderId: string) {
    return this.request<CfPayment[]>({
      method: 'GET',
      url: `/orders/${encodeURIComponent(orderId)}/payments`,
    });
  }

  terminateOrder(orderId: string) {
    return this.request<CfOrder>({
      method: 'PATCH',
      url: `/orders/${encodeURIComponent(orderId)}`,
      data: { order_status: 'TERMINATED' },
    });
  }

  // signature = base64(hmac_sha256(timestamp + rawBody, secretKey))
  verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean {
    if (!rawBody || !timestamp || !signature) return false;

    const expected = createHmac('sha256', this.secretKey)
      .update(timestamp + rawBody)
      .digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // timingSafeEqual throws if lengths differ
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async request<T>(req: AxiosRequestConfig): Promise<T> {
    let lastError: CashfreeApiError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.http.request<T>(req);
        return res.data;
      } catch (err) {
        lastError = this.toApiError(err);
        this.logger.warn(
          `cashfree ${req.method} ${req.url} failed (attempt ${attempt}): ${lastError.message}`,
        );
        if (!lastError.retryable || attempt === MAX_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
      }
    }

    throw lastError;
  }

  private toApiError(err: unknown): CashfreeApiError {
    if (err instanceof AxiosError) {
      const data = err.response?.data as { message?: string; code?: string } | undefined;
      return new CashfreeApiError(data?.message ?? err.message, err.response?.status, data?.code);
    }
    return new CashfreeApiError((err as Error)?.message ?? 'unknown cashfree error');
  }
}
