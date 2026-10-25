import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FeeInvoice, PrismaClient, Student } from '@prisma/client';
import { createHmac } from 'crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { CashfreeApiError, CashfreeService } from '../src/cashfree/cashfree.service';
import { CfPaymentStatus } from '../src/cashfree/cashfree.types';
import { ReconciliationService } from '../src/payments/reconciliation.service';
import { FakeCashfree } from './fake-cashfree';

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let cf: FakeCashfree;
  const prisma = new PrismaClient();

  let student: Student;
  let other: Student;
  let invoice: FeeInvoice;
  let invoice2: FeeInvoice;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CashfreeService)
      .useFactory({ factory: (c: ConfigService) => new FakeCashfree(c), inject: [ConfigService] })
      .compile();

    app = configureApp(moduleRef.createNestApplication({ rawBody: true }));
    await app.init();
    cf = app.get(CashfreeService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    cf.reset();
    await prisma.$executeRawUnsafe(
      'TRUNCATE payment_status_history, payment_transactions, webhook_events, payment_orders, fee_invoices, students CASCADE',
    );
    student = await prisma.student.create({
      data: { rollNumber: 'CS1', name: 'Test Student', email: 't@x.com', phone: '9999999999' },
    });
    other = await prisma.student.create({
      data: { rollNumber: 'CS2', name: 'Other Student', email: 'o@x.com', phone: '9888888888' },
    });
    invoice = await prisma.feeInvoice.create({
      data: { studentId: student.id, title: 'Tuition', feeType: 'TUITION', amount: 1500 },
    });
    invoice2 = await prisma.feeInvoice.create({
      data: { studentId: student.id, title: 'Hostel', feeType: 'HOSTEL', amount: 800 },
    });
  });

  // ---------- helpers ----------

  const http = () => request(app.getHttpServer());
  const ADMIN_KEY = 'test_admin_key';

  const createOrder = (invoiceId = invoice.id, key?: string, studentId = student.id) => {
    const req = http().post('/payments/orders');
    if (key) req.set('Idempotency-Key', key);
    return req.send({ invoiceId, studentId });
  };

  const sendWebhook = (
    orderId: string,
    status: CfPaymentStatus,
    opts: { secret?: string; key?: string } = {},
  ) => {
    const type =
      status === 'SUCCESS'
        ? 'PAYMENT_SUCCESS_WEBHOOK'
        : status === 'USER_DROPPED'
          ? 'PAYMENT_USER_DROPPED_WEBHOOK'
          : 'PAYMENT_FAILED_WEBHOOK';
    const body = JSON.stringify({
      type,
      event_time: new Date().toISOString(),
      data: { order: { order_id: orderId }, payment: { payment_status: status } },
    });
    const ts = String(Date.now());
    const sig = createHmac('sha256', opts.secret ?? 'test_secret')
      .update(ts + body)
      .digest('base64');
    const req = http()
      .post('/webhooks/cashfree')
      .set('content-type', 'application/json')
      .set('x-webhook-timestamp', ts)
      .set('x-webhook-signature', sig);
    if (opts.key) req.set('x-idempotency-key', opts.key);
    return req.send(body);
  };

  const dbOrder = (orderId: string) =>
    prisma.paymentOrder.findUniqueOrThrow({ where: { orderId }, include: { history: true } });
  const dbInvoice = (id = invoice.id) => prisma.feeInvoice.findUniqueOrThrow({ where: { id } });

  // ---------- creating orders ----------

  describe('POST /payments/orders', () => {
    it('creates a cashfree order and returns the session id', async () => {
      const res = await createOrder().expect(201);

      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        amount: '1500',
        currency: 'INR',
        reused: false,
      });
      expect(res.body.paymentSessionId).toBe(`session_${res.body.orderId}`);
      expect(res.body.orderId).toMatch(/^UMS_/);

      const order = await dbOrder(res.body.orderId);
      expect(order.history.map((h) => h.toStatus)).toEqual(['CREATED', 'ACTIVE']);
      expect((await dbInvoice()).status).toBe('UNPAID');
    });

    it('returns the same order for a repeated Idempotency-Key', async () => {
      const first = await createOrder(invoice.id, 'click-1').expect(201);
      const second = await createOrder(invoice.id, 'click-1').expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.reused).toBe(true);
      expect(cf.createCalls).toBe(1);
    });

    it('rejects an Idempotency-Key reused for another invoice', async () => {
      await createOrder(invoice.id, 'click-1').expect(201);
      const res = await createOrder(invoice2.id, 'click-1').expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('reuses the open order when the student clicks pay again', async () => {
      const first = await createOrder().expect(201);
      const second = await createOrder().expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.reused).toBe(true);
      expect(await prisma.paymentOrder.count()).toBe(1);
    });

    it('creates only one order for concurrent requests', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => createOrder()));

      results.forEach((r) => expect(r.status).toBe(201));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.paymentOrder.count()).toBe(1);
    });

    it('rejects an invoice of another student', async () => {
      const res = await createOrder(invoice.id, undefined, other.id).expect(403);
      expect(res.body.code).toBe('INVOICE_NOT_OWNED');
    });

    it('rejects unknown invoice and invalid body', async () => {
      const res = await createOrder('00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('INVOICE_NOT_FOUND');

      const bad = await http().post('/payments/orders').send({ invoiceId: 'x' }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invoice that is already paid', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');
      await sendWebhook(body.orderId, 'SUCCESS').expect(200);

      const res = await createOrder().expect(409);
      expect(res.body.code).toBe('INVOICE_ALREADY_PAID');
    });

    it('keeps the order when cashfree is down and finishes it on retry', async () => {
      cf.nextCreateError = new CashfreeApiError('gateway timeout', 504);
      const res = await createOrder().expect(503);
      expect(res.body.code).toBe('GATEWAY_UNAVAILABLE');

      const [pending] = await prisma.paymentOrder.findMany();
      expect(pending.status).toBe('CREATED');

      const retry = await createOrder().expect(201);
      expect(retry.body.id).toBe(pending.id);
      expect(retry.body.status).toBe('ACTIVE');
    });

    it('recovers when cashfree created the order but we lost the response', async () => {
      cf.nextCreateError = new CashfreeApiError('gateway timeout', 504);
      await createOrder().expect(503);
      const [pending] = await prisma.paymentOrder.findMany();
      // cashfree actually created it
      await cf.createOrder({
        order_id: pending.orderId,
        order_amount: 1500,
        order_currency: 'INR',
        customer_details: { customer_id: 'CS1', customer_phone: '9999999999' },
      });

      const retry = await createOrder().expect(201); // createOrder now gets 409 -> fetches it
      expect(retry.body.status).toBe('ACTIVE');
      expect(retry.body.paymentSessionId).toBe(`session_${pending.orderId}`);
    });

    it('cancels the order when cashfree rejects it, next attempt starts fresh', async () => {
      cf.nextCreateError = new CashfreeApiError('customer_phone is invalid', 400);
      const res = await createOrder().expect(502);
      expect(res.body.code).toBe('GATEWAY_REJECTED');

      const [rejected] = await prisma.paymentOrder.findMany();
      expect(rejected.status).toBe('CANCELLED');

      const next = await createOrder().expect(201);
      expect(next.body.id).not.toBe(rejected.id);
    });
  });

  // ---------- webhooks ----------

  describe('POST /webhooks/cashfree', () => {
    it('marks order and invoice paid on a success webhook', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');

      await sendWebhook(body.orderId, 'SUCCESS').expect(200);

      const order = await dbOrder(body.orderId);
      expect(order.status).toBe('PAID');
      expect(order.paidAt).not.toBeNull();
      const inv = await dbInvoice();
      expect(inv.status).toBe('PAID');
      expect(inv.paidOrderId).toBe(order.id);
      expect(await prisma.paymentTransaction.count()).toBe(1);
      const last = order.history[order.history.length - 1];
      expect(last).toMatchObject({ toStatus: 'PAID', source: 'WEBHOOK' });
    });

    it('rejects a webhook with a bad signature and changes nothing', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');

      const res = await sendWebhook(body.orderId, 'SUCCESS', { secret: 'wrong' }).expect(401);
      expect(res.body.code).toBe('INVALID_SIGNATURE');
      expect((await dbOrder(body.orderId)).status).toBe('ACTIVE');
      expect((await dbInvoice()).status).toBe('UNPAID');
    });

    it('processes a retried (duplicate) webhook only once', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');

      await sendWebhook(body.orderId, 'SUCCESS', { key: 'evt-1' }).expect(200);
      const dup = await sendWebhook(body.orderId, 'SUCCESS', { key: 'evt-1' }).expect(200);

      expect(dup.body.duplicate).toBe(true);
      expect(await prisma.webhookEvent.count()).toBe(1);
      const paid = (await dbOrder(body.orderId)).history.filter((h) => h.toStatus === 'PAID');
      expect(paid).toHaveLength(1);
    });

    it('a forged event cannot block the real one with the same key', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');

      await sendWebhook(body.orderId, 'SUCCESS', { key: 'evt-1', secret: 'wrong' }).expect(401);
      const real = await sendWebhook(body.orderId, 'SUCCESS', { key: 'evt-1' }).expect(200);

      expect(real.body.duplicate).toBeUndefined();
      expect((await dbOrder(body.orderId)).status).toBe('PAID');
    });

    it('ignores a late failure webhook for an order that is already paid', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS');
      await sendWebhook(body.orderId, 'SUCCESS').expect(200);

      cf.pay(body.orderId, 'FAILED'); // a stale attempt reported after the success
      await sendWebhook(body.orderId, 'FAILED').expect(200);

      expect((await dbOrder(body.orderId)).status).toBe('PAID');
      expect((await dbInvoice()).status).toBe('PAID');
    });

    it('handles fail -> retry -> success on the same order', async () => {
      const { body } = await createOrder().expect(201);

      cf.pay(body.orderId, 'FAILED');
      await sendWebhook(body.orderId, 'FAILED').expect(200);
      let order = await dbOrder(body.orderId);
      expect(order.status).toBe('FAILED');
      expect(order.failureReason).toBe('bank declined');

      cf.pay(body.orderId, 'SUCCESS');
      await sendWebhook(body.orderId, 'SUCCESS').expect(200);
      order = await dbOrder(body.orderId);
      expect(order.status).toBe('PAID');
      expect(order.failureReason).toBeNull();
      expect(await prisma.paymentTransaction.count()).toBe(2);
    });

    it('records a user dropped checkout and lets the student pay again', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'USER_DROPPED');
      await sendWebhook(body.orderId, 'USER_DROPPED').expect(200);
      expect((await dbOrder(body.orderId)).status).toBe('USER_DROPPED');

      const again = await createOrder().expect(201);
      expect(again.body.id).toBe(body.id); // same order, same session
    });

    it('flags the order when the paid amount is less than the invoice', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS', 1000);
      await sendWebhook(body.orderId, 'SUCCESS').expect(200);

      const order = await dbOrder(body.orderId);
      expect(order.status).toBe('FLAGGED');
      expect(order.history.at(-1)?.note).toMatch(/amount mismatch/);
      expect((await dbInvoice()).status).toBe('UNPAID');
    });

    it('ignores webhooks for orders that are not ours', async () => {
      const res = await sendWebhook('SOMEONE_ELSE_123', 'SUCCESS').expect(200);
      expect(res.body.received).toBe(true);
      const [event] = await prisma.webhookEvent.findMany();
      expect(event.status).toBe('IGNORED');
    });
  });

  // ---------- verify, cancel, reconcile ----------

  describe('verify / cancel / reconcile', () => {
    it('verify pulls the latest state from cashfree', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'PENDING');

      const res = await http().post(`/payments/orders/${body.orderId}/verify`).expect(200);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.transactions).toHaveLength(1);
    });

    it('does not allow paying again while a payment is pending', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'PENDING');
      await http().post(`/payments/orders/${body.id}/verify`).expect(200);

      const res = await createOrder().expect(409);
      expect(res.body.code).toBe('PAYMENT_IN_PROGRESS');
    });

    it('cancels an open order on both sides', async () => {
      const { body } = await createOrder().expect(201);

      const res = await http()
        .post(`/payments/orders/${body.id}/cancel`)
        .set('x-admin-key', ADMIN_KEY)
        .send({ reason: 'fee waived' })
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(cf.orders.get(body.orderId)?.order_status).toBe('TERMINATED');
      const last = (await dbOrder(body.orderId)).history.at(-1);
      expect(last).toMatchObject({ toStatus: 'CANCELLED', source: 'ADMIN', note: 'fee waived' });
    });

    it('refuses to cancel a pending or paid order', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'PENDING');
      await http().post(`/payments/orders/${body.id}/verify`).expect(200);
      await http()
        .post(`/payments/orders/${body.id}/cancel`)
        .set('x-admin-key', ADMIN_KEY)
        .send({})
        .expect(409);

      cf.pay(body.orderId, 'SUCCESS');
      await http().post(`/payments/orders/${body.id}/verify`).expect(200);
      const res = await http()
        .post(`/payments/orders/${body.id}/cancel`)
        .set('x-admin-key', ADMIN_KEY)
        .send({})
        .expect(409);
      expect(res.body.code).toBe('ORDER_ALREADY_PAID');
    });

    it('admin routes need the admin key', async () => {
      const { body } = await createOrder().expect(201);

      const missing = await http().post(`/payments/orders/${body.id}/cancel`).send({}).expect(401);
      expect(missing.body.code).toBe('ADMIN_KEY_REQUIRED');
      await http()
        .post(`/payments/orders/${body.id}/cancel`)
        .set('x-admin-key', 'wrong')
        .send({})
        .expect(401);
      await http().post('/payments/reconcile').expect(401);

      expect((await dbOrder(body.orderId)).status).toBe('ACTIVE');
      await http().post('/payments/reconcile').set('x-admin-key', ADMIN_KEY).expect(200);
    });

    it('reconciliation fixes an order whose webhook never arrived', async () => {
      const { body } = await createOrder().expect(201);
      cf.pay(body.orderId, 'SUCCESS'); // paid, but no webhook
      await prisma.paymentOrder.update({
        where: { id: body.id },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

      const summary = await app.get(ReconciliationService).run();

      expect(summary).toEqual({ checked: 1, changed: 1, failed: 0 });
      const order = await dbOrder(body.orderId);
      expect(order.status).toBe('PAID');
      expect(order.history.at(-1)?.source).toBe('RECONCILE');
      expect((await dbInvoice()).status).toBe('PAID');
    });

    it('marks expired orders and lets a new one be created', async () => {
      const { body } = await createOrder().expect(201);
      cf.expire(body.orderId);
      await http().post(`/payments/orders/${body.id}/verify`).expect(200);
      expect((await dbOrder(body.orderId)).status).toBe('EXPIRED');

      const next = await createOrder().expect(201);
      expect(next.body.id).not.toBe(body.id);
      expect(next.body.reused).toBe(false);
    });

    it('flags a double payment instead of losing the money', async () => {
      // order A is cancelled, order B pays the invoice, then A turns out to be paid too
      const a = (await createOrder().expect(201)).body;
      await http()
        .post(`/payments/orders/${a.id}/cancel`)
        .set('x-admin-key', ADMIN_KEY)
        .send({})
        .expect(200);

      const b = (await createOrder().expect(201)).body;
      cf.pay(b.orderId, 'SUCCESS');
      await sendWebhook(b.orderId, 'SUCCESS').expect(200);

      cf.orders.get(a.orderId)!.order_status = 'ACTIVE'; // bank race: payment landed anyway
      cf.pay(a.orderId, 'SUCCESS');
      await sendWebhook(a.orderId, 'SUCCESS').expect(200);

      const orderA = await dbOrder(a.orderId);
      expect(orderA.status).toBe('FLAGGED');
      expect(orderA.history.at(-1)?.note).toMatch(/double payment/);
      expect((await dbInvoice()).paidOrderId).toBe(b.id);
    });
  });

  describe('GET endpoints', () => {
    it('returns an order by uuid and by merchant order id', async () => {
      const { body } = await createOrder().expect(201);
      const byId = await http().get(`/payments/orders/${body.id}`).expect(200);
      const byOrderId = await http().get(`/payments/orders/${body.orderId}`).expect(200);

      expect(byOrderId.body.id).toBe(byId.body.id);
      expect(byId.body.history).toHaveLength(2);
    });

    it('lists invoices and payment history of a student', async () => {
      await createOrder().expect(201);
      const invoices = await http().get(`/students/${student.id}/invoices`).expect(200);
      const payments = await http().get(`/students/${student.id}/payments`).expect(200);

      expect(invoices.body).toHaveLength(2);
      expect(payments.body).toHaveLength(1);
      expect(payments.body[0].invoice.title).toBe('Tuition');
    });

    it('lists students for the demo page', async () => {
      const res = await http().get('/students').expect(200);
      expect(res.body.map((s: Student) => s.rollNumber)).toEqual(['CS1', 'CS2']);
    });
  });
});
