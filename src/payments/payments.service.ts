import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InvoiceStatus,
  PaymentOrder,
  PaymentOrderStatus as S,
  Prisma,
  StatusSource,
  Student,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { CashfreeApiError, CashfreeService } from '../cashfree/cashfree.service';
import { CfOrder, CfPayment } from '../cashfree/cashfree.types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  canTransition,
  deriveStatus,
  isOpen,
  latestPayment,
  OPEN_STATUSES,
} from './payment-status';

type Tx = Prisma.TransactionClient;

// don't hand out an order that is about to expire, student needs time to pay
const MIN_REMAINING_MS = 2 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeService,
    private readonly config: ConfigService,
  ) {}

  async createOrder(dto: CreateOrderDto, idempotencyKey?: string) {
    // same key sent again (double click, client retry) -> same order back
    if (idempotencyKey) {
      const existing = await this.prisma.paymentOrder.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.invoiceId !== dto.invoiceId) {
          throw new UnprocessableEntityException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency-Key was already used for a different invoice',
          });
        }
        return this.checkoutResponse(existing, true);
      }
    }

    const invoice = await this.prisma.feeInvoice.findUnique({
      where: { id: dto.invoiceId },
      include: { student: true },
    });
    if (!invoice) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    }
    if (invoice.studentId !== dto.studentId) {
      throw new ForbiddenException({
        code: 'INVOICE_NOT_OWNED',
        message: 'Invoice does not belong to this student',
      });
    }
    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException({
        code: 'INVOICE_ALREADY_PAID',
        message: 'Invoice is already paid',
      });
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new ConflictException({ code: 'INVOICE_CANCELLED', message: 'Invoice is cancelled' });
    }

    // an open order already exists for this invoice? reuse it instead of creating another
    const open = await this.findUsableOpenOrder(invoice.id);
    if (open) return this.resumeOpenOrder(open, invoice.student, invoice.title);

    const expiryMinutes = this.config.get<number>('payment.orderExpiryMinutes')!;
    let order: PaymentOrder;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.paymentOrder.create({
          data: {
            orderId: this.newOrderId(),
            invoiceId: invoice.id,
            studentId: invoice.studentId,
            amount: invoice.amount,
            currency: invoice.currency,
            idempotencyKey,
            expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
          },
        });
        await tx.paymentStatusHistory.create({
          data: { paymentOrderId: created.id, toStatus: S.CREATED, source: StatusSource.API },
        });
        return created;
      });
    } catch (e) {
      // lost a race: another request created the order (same key or same invoice) a moment ago
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner =
          (idempotencyKey &&
            (await this.prisma.paymentOrder.findUnique({ where: { idempotencyKey } }))) ||
          (await this.prisma.paymentOrder.findFirst({
            where: { invoiceId: invoice.id, status: { in: OPEN_STATUSES } },
          }));
        if (winner) return this.resumeOpenOrder(winner, invoice.student, invoice.title);
      }
      throw e;
    }

    return this.registerWithCashfree(order, invoice.student, invoice.title);
  }

  async getOrder(idOrOrderId: string) {
    const order = await this.prisma.paymentOrder.findFirst({
      where: UUID_RE.test(idOrOrderId) ? { id: idOrOrderId } : { orderId: idOrOrderId },
      include: {
        invoice: { select: { id: true, title: true, status: true } },
        transactions: {
          orderBy: { createdAt: 'asc' },
          select: {
            cfPaymentId: true,
            status: true,
            amount: true,
            paymentGroup: true,
            bankReference: true,
            paymentMessage: true,
            errorCode: true,
            errorReason: true,
            paymentTime: true,
          },
        },
        history: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Payment order not found' });
    }
    return order;
  }

  /**
   * Pulls the real state of an order from cashfree and applies it.
   * Used by the verify api, webhooks and the reconciliation job, so all
   * three go through exactly the same rules.
   */
  async syncOrder(id: string, source: StatusSource): Promise<PaymentOrder> {
    let order = await this.prisma.paymentOrder.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Payment order not found' });
    }

    if (!order.cfOrderId) {
      // we never got cashfree's response, it may or may not have created the order
      const found = await this.cashfree.getOrder(order.orderId).catch((e) => {
        if (e instanceof CashfreeApiError && e.httpStatus === 404) return null;
        throw e;
      });
      if (!found) {
        if (order.expiresAt < new Date() && isOpen(order.status)) {
          return this.transition(order.id, S.EXPIRED, source, 'never registered with cashfree');
        }
        return order;
      }
      order = await this.prisma.paymentOrder.update({
        where: { id },
        data: {
          cfOrderId: String(found.cf_order_id),
          paymentSessionId: found.payment_session_id,
        },
      });
    }

    const [cfOrder, payments] = await Promise.all([
      this.cashfree.getOrder(order.orderId),
      this.cashfree.getPayments(order.orderId),
    ]);

    return this.prisma.$transaction(
      async (tx) => {
        const current = await this.lockOrder(tx, id);

        for (const p of payments) {
          await this.upsertTransaction(tx, current.id, p);
        }

        let target = deriveStatus(cfOrder.order_status, payments);
        let note: string | undefined;

        if (target === S.PAID && canTransition(current.status, S.PAID)) {
          note = this.checkAmount(current, cfOrder, payments);
          if (!note) note = await this.markInvoicePaid(tx, current);
          if (note) target = S.FLAGGED;
        }

        const latest = latestPayment(payments);
        const failed = target === S.FAILED || target === S.USER_DROPPED;
        const failureReason = failed
          ? (latest?.error_details?.error_description ?? latest?.payment_message ?? null)
          : null;

        return this.applyTransition(tx, current, target, source, note, {
          lastSyncedAt: new Date(),
          failureReason,
          ...(target === S.PAID && { paidAt: new Date() }),
        });
      },
      { timeout: 15000 },
    );
  }

  async cancelOrder(id: string, reason?: string) {
    const order = await this.getOrder(id);

    if (order.status === S.PAID) {
      throw new ConflictException({ code: 'ORDER_ALREADY_PAID', message: 'Order is already paid' });
    }
    if (order.status === S.PENDING) {
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        message: 'A payment is being processed, try again after it completes',
      });
    }
    if (!isOpen(order.status)) {
      throw new ConflictException({ code: 'ORDER_NOT_OPEN', message: `Order is ${order.status}` });
    }

    if (order.cfOrderId) {
      try {
        await this.cashfree.terminateOrder(order.orderId);
      } catch (e) {
        // usually means it got paid or expired in the meantime, sync below will tell
        this.logger.warn(`terminate ${order.orderId} failed: ${(e as Error).message}`);
      }
      const synced = await this.syncOrder(order.id, StatusSource.ADMIN);
      if (synced.status === S.PAID) {
        throw new ConflictException({
          code: 'ORDER_ALREADY_PAID',
          message: 'Order got paid before it could be cancelled',
        });
      }
      if (!isOpen(synced.status)) return synced;
    }

    return this.transition(order.id, S.CANCELLED, StatusSource.ADMIN, reason ?? 'cancelled');
  }

  // ---------- helpers ----------

  private async findUsableOpenOrder(invoiceId: string) {
    const open = await this.prisma.paymentOrder.findFirst({
      where: { invoiceId, status: { in: OPEN_STATUSES } },
    });
    if (!open) return null;
    if (open.expiresAt.getTime() - Date.now() > MIN_REMAINING_MS) return open;

    // about to expire: retire it so a fresh order can be created.
    // ask cashfree first - the student may have actually paid on it
    const synced = await this.syncOrder(open.id, StatusSource.API);
    if (synced.status === S.PAID) {
      throw new ConflictException({
        code: 'INVOICE_ALREADY_PAID',
        message: 'Invoice is already paid',
      });
    }
    if (synced.status === S.PENDING) return synced; // resumeOpenOrder rejects it
    if (isOpen(synced.status)) {
      if (synced.cfOrderId) {
        await this.cashfree.terminateOrder(synced.orderId).catch(() => undefined);
      }
      await this.transition(
        synced.id,
        S.EXPIRED,
        StatusSource.API,
        'expired, replaced by new order',
      );
    }
    return null;
  }

  private async resumeOpenOrder(order: PaymentOrder, student: Student, title: string) {
    if (order.status === S.PENDING) {
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        message:
          'A payment for this invoice is being processed, check its status before paying again',
      });
    }
    if (order.status === S.CREATED) {
      // earlier attempt to reach cashfree failed, try again with the same order
      return this.registerWithCashfree(order, student, title);
    }
    return this.checkoutResponse(order, true);
  }

  private async registerWithCashfree(order: PaymentOrder, student: Student, title: string) {
    const returnUrl = this.config.get<string>('payment.returnUrl');
    const notifyUrl = this.config.get<string>('payment.notifyUrl');

    let cfOrder: CfOrder;
    try {
      cfOrder = await this.cashfree.createOrder(
        {
          order_id: order.orderId,
          order_amount: order.amount.toNumber(),
          order_currency: order.currency,
          customer_details: {
            customer_id: student.rollNumber,
            customer_phone: student.phone,
            customer_email: student.email,
            customer_name: student.name,
          },
          order_meta: {
            ...(returnUrl && { return_url: returnUrl }),
            ...(notifyUrl && { notify_url: notifyUrl }),
          },
          order_expiry_time: order.expiresAt.toISOString(),
          order_note: title.slice(0, 200),
          order_tags: { invoice_id: order.invoiceId, student_id: order.studentId },
        },
        order.id, // our uuid doubles as cashfree's idempotency key
      );
    } catch (e) {
      if (!(e instanceof CashfreeApiError)) throw e;

      if (e.httpStatus === 409) {
        // already created on cashfree by an earlier attempt whose response we lost
        cfOrder = await this.cashfree.getOrder(order.orderId);
      } else if (e.retryable) {
        // order stays CREATED, the next request for this invoice retries it
        throw new ServiceUnavailableException({
          code: 'GATEWAY_UNAVAILABLE',
          message: 'Payment gateway is not reachable right now, please retry',
        });
      } else {
        await this.transition(
          order.id,
          S.CANCELLED,
          StatusSource.API,
          `cashfree rejected: ${e.message}`,
        );
        throw new BadGatewayException({ code: 'GATEWAY_REJECTED', message: e.message });
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOrder(tx, order.id);
      return this.applyTransition(tx, current, S.ACTIVE, StatusSource.API, undefined, {
        cfOrderId: String(cfOrder.cf_order_id),
        paymentSessionId: cfOrder.payment_session_id,
      });
    });

    return this.checkoutResponse(updated, false);
  }

  // returns a note when what cashfree collected doesn't match what we asked for
  private checkAmount(order: PaymentOrder, cfOrder: CfOrder, payments: CfPayment[]) {
    const success = payments.find((p) => p.payment_status === 'SUCCESS');
    const orderAmount = new Prisma.Decimal(cfOrder.order_amount);
    // payment_amount can be higher than order amount if a surcharge was collected, never lower
    const paidAmount = new Prisma.Decimal(success?.payment_amount ?? cfOrder.order_amount);

    if (!orderAmount.eq(order.amount) || paidAmount.lt(order.amount)) {
      return `amount mismatch: expected ${order.amount}, cashfree order ${orderAmount}, paid ${paidAmount}`;
    }
    return undefined;
  }

  // returns a note if the payment can't be applied to the invoice (needs manual review)
  private async markInvoicePaid(tx: Tx, order: PaymentOrder): Promise<string | undefined> {
    await tx.$queryRaw`SELECT id FROM fee_invoices WHERE id = ${order.invoiceId}::uuid FOR UPDATE`;
    const invoice = await tx.feeInvoice.findUniqueOrThrow({ where: { id: order.invoiceId } });

    if (invoice.status === InvoiceStatus.PAID && invoice.paidOrderId !== order.id) {
      return `double payment: invoice already paid by order ${invoice.paidOrderId}, refund needed`;
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
      return 'paid against a cancelled invoice, refund needed';
    }

    await tx.feeInvoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID, paidAt: new Date(), paidOrderId: order.id },
    });
    return undefined;
  }

  private async upsertTransaction(tx: Tx, paymentOrderId: string, p: CfPayment) {
    const data = {
      status: p.payment_status,
      amount: new Prisma.Decimal(p.payment_amount),
      currency: p.payment_currency ?? 'INR',
      paymentGroup: p.payment_group ?? null,
      bankReference: p.bank_reference ?? null,
      paymentMessage: p.payment_message ?? null,
      errorCode: p.error_details?.error_code ?? null,
      errorReason: p.error_details?.error_reason ?? null,
      paymentTime: p.payment_time ? new Date(p.payment_time) : null,
      raw: p as unknown as Prisma.InputJsonValue,
    };
    await tx.paymentTransaction.upsert({
      where: { cfPaymentId: String(p.cf_payment_id) },
      create: { paymentOrderId, cfPaymentId: String(p.cf_payment_id), ...data },
      update: data,
    });
  }

  private transition(id: string, to: S, source: StatusSource, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockOrder(tx, id);
      return this.applyTransition(tx, current, to, source, note);
    });
  }

  // row lock so a webhook, a verify call and the cron can't update the same order at once
  private async lockOrder(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM payment_orders WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.paymentOrder.findUniqueOrThrow({ where: { id } });
  }

  private async applyTransition(
    tx: Tx,
    current: PaymentOrder,
    to: S,
    source: StatusSource,
    note?: string,
    extra: Prisma.PaymentOrderUpdateInput = {},
  ) {
    if (current.status !== to && !canTransition(current.status, to)) {
      // e.g. a late FAILED event for an order that is already PAID - ignore it
      this.logger.warn(`ignored ${current.status} -> ${to} for ${current.orderId} (${source})`);
      return tx.paymentOrder.update({
        where: { id: current.id },
        data: { lastSyncedAt: new Date() },
      });
    }

    const updated = await tx.paymentOrder.update({
      where: { id: current.id },
      data: { ...extra, status: to },
    });

    if (current.status !== to) {
      await tx.paymentStatusHistory.create({
        data: {
          paymentOrderId: current.id,
          fromStatus: current.status,
          toStatus: to,
          source,
          note,
        },
      });
      this.logger.log(`${current.orderId}: ${current.status} -> ${to} (${source})`);
    }
    return updated;
  }

  private checkoutResponse(order: PaymentOrder, reused: boolean) {
    return {
      id: order.id,
      orderId: order.orderId,
      status: order.status,
      amount: order.amount.toString(),
      currency: order.currency,
      paymentSessionId: order.paymentSessionId,
      expiresAt: order.expiresAt,
      cashfreeMode: this.config.get('cashfree.env'),
      reused,
    };
  }

  private newOrderId() {
    // cashfree allows 3-45 chars: letters, numbers, _ and -
    const ts = Date.now().toString(36).toUpperCase();
    return `UMS_${ts}_${randomBytes(4).toString('hex').toUpperCase()}`;
  }
}
