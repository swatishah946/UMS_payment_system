import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, StatusSource, WebhookEventStatus } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { CashfreeService } from '../cashfree/cashfree.service';
import { CfWebhookPayload } from '../cashfree/cashfree.types';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';

// events that change a payment's state. others (e.g. PAYMENT_CHARGES_WEBHOOK) are just logged
const PAYMENT_EVENTS = [
  'PAYMENT_SUCCESS_WEBHOOK',
  'PAYMENT_FAILED_WEBHOOK',
  'PAYMENT_USER_DROPPED_WEBHOOK',
];

export interface WebhookHeaders {
  signature?: string;
  timestamp?: string;
  idempotencyKey?: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeService,
    private readonly payments: PaymentsService,
  ) {}

  async handleCashfree(rawBody: string, headers: WebhookHeaders) {
    let payload: CfWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException({ code: 'INVALID_PAYLOAD', message: 'Body is not valid JSON' });
    }

    const eventType = payload?.type ?? null;
    const orderId = payload?.data?.order?.order_id ?? null;
    const cfPaymentId = payload?.data?.payment?.cf_payment_id;

    const signatureValid = this.cashfree.verifyWebhookSignature(
      rawBody,
      headers.timestamp ?? '',
      headers.signature ?? '',
    );

    if (!signatureValid) {
      // keep a record for debugging, but under a random key so a forged request
      // can never "use up" the dedupe key of a real event
      await this.prisma.webhookEvent.create({
        data: {
          eventKey: `invalid:${randomUUID()}`,
          eventType,
          orderId,
          cfPaymentId: cfPaymentId ? String(cfPaymentId) : null,
          signatureValid: false,
          status: WebhookEventStatus.IGNORED,
          error: 'invalid signature',
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.warn(`rejected webhook with invalid signature (order ${orderId})`);
      throw new UnauthorizedException({ code: 'INVALID_SIGNATURE', message: 'Invalid signature' });
    }

    // cashfree retries the same event if we don't answer 200, dedupe on its key
    const eventKey = headers.idempotencyKey
      ? `idem:${headers.idempotencyKey}`
      : `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;

    const event = await this.recordEvent(eventKey, {
      eventType,
      orderId,
      cfPaymentId: cfPaymentId ? String(cfPaymentId) : null,
      payload,
    });
    if (!event) return { received: true, duplicate: true };

    if (!eventType || !PAYMENT_EVENTS.includes(eventType)) {
      await this.finish(event.id, WebhookEventStatus.IGNORED, `unhandled event type ${eventType}`);
      return { received: true };
    }

    const order = orderId
      ? await this.prisma.paymentOrder.findUnique({ where: { orderId } })
      : null;
    if (!order) {
      // not one of ours (e.g. another app on the same cashfree account)
      await this.finish(event.id, WebhookEventStatus.IGNORED, `unknown order ${orderId}`);
      return { received: true };
    }

    try {
      // don't trust the payload's status on its own - ask cashfree for the current
      // state. this also handles events arriving out of order
      await this.payments.syncOrder(order.id, StatusSource.WEBHOOK);
      await this.finish(event.id, WebhookEventStatus.PROCESSED);
    } catch (e) {
      const message = (e as Error).message;
      await this.finish(event.id, WebhookEventStatus.FAILED, message);
      this.logger.error(`webhook for ${orderId} failed: ${message}`);
      // non 2xx makes cashfree retry later. the reconciliation job is the second safety net
      throw new ServiceUnavailableException({ code: 'PROCESSING_FAILED', message: 'Retry later' });
    }

    return { received: true };
  }

  /**
   * Saves the event, or returns null if it was already handled.
   * An event that previously FAILED is picked up again so cashfree's retry can succeed.
   */
  private async recordEvent(
    eventKey: string,
    data: {
      eventType: string | null;
      orderId: string | null;
      cfPaymentId: string | null;
      payload: unknown;
    },
  ) {
    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventKey } });
    if (existing) {
      if (existing.status === WebhookEventStatus.FAILED) return existing;
      this.logger.log(`duplicate webhook ${eventKey} ignored`);
      return null;
    }

    try {
      return await this.prisma.webhookEvent.create({
        data: {
          eventKey,
          eventType: data.eventType,
          orderId: data.orderId,
          cfPaymentId: data.cfPaymentId,
          signatureValid: true,
          payload: data.payload as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      // the same event delivered twice at the same moment
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }

  private finish(id: string, status: WebhookEventStatus, error?: string) {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { status, error: error ?? null, processedAt: new Date() },
    });
  }
}
