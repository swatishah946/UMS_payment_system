import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StatusSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OPEN_STATUSES } from './payment-status';
import { PaymentsService } from './payments.service';

// give the webhook a chance to arrive before we start polling an order
const STALE_AFTER_MS = 5 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Safety net for missed webhooks: if our server was down, the webhook url was
 * wrong, or cashfree gave up retrying, open orders would stay stuck forever.
 * This job asks cashfree about them and brings them up to date.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduled() {
    await this.run();
  }

  async run() {
    // a slow cashfree could make one run overlap with the next
    if (this.running) {
      this.logger.warn('previous reconciliation still running, skipping');
      return { skipped: true };
    }
    this.running = true;

    const summary = { checked: 0, changed: 0, failed: 0 };
    try {
      const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
      const orders = await this.prisma.paymentOrder.findMany({
        where: {
          status: { in: OPEN_STATUSES },
          createdAt: { lt: staleBefore },
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const order of orders) {
        summary.checked++;
        try {
          const synced = await this.payments.syncOrder(order.id, StatusSource.RECONCILE);
          if (synced.status !== order.status) summary.changed++;
        } catch (e) {
          // one bad order must not stop the rest, it will be retried next run
          summary.failed++;
          this.logger.error(`reconcile ${order.orderId} failed: ${(e as Error).message}`);
        }
      }

      if (summary.checked) this.logger.log(`reconciliation done ${JSON.stringify(summary)}`);
      return summary;
    } finally {
      this.running = false;
    }
  }
}
