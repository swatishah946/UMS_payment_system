import { ConfigService } from '@nestjs/config';
import { CashfreeApiError, CashfreeService } from '../src/cashfree/cashfree.service';
import {
  CfCreateOrderRequest,
  CfOrder,
  CfPayment,
  CfPaymentStatus,
} from '../src/cashfree/cashfree.types';

/**
 * In-memory stand-in for cashfree's PG api. Signature verification is
 * inherited from the real service so webhook tests use the real check.
 */
export class FakeCashfree extends CashfreeService {
  orders = new Map<string, CfOrder>();
  payments = new Map<string, CfPayment[]>();
  createCalls = 0;
  nextCreateError?: CashfreeApiError;
  private seq = 1;

  constructor(config: ConfigService) {
    super(config);
  }

  reset() {
    this.orders.clear();
    this.payments.clear();
    this.createCalls = 0;
    this.nextCreateError = undefined;
  }

  async createOrder(body: CfCreateOrderRequest): Promise<CfOrder> {
    this.createCalls++;
    if (this.nextCreateError) {
      const e = this.nextCreateError;
      this.nextCreateError = undefined;
      throw e;
    }
    if (this.orders.has(body.order_id)) {
      throw new CashfreeApiError('order already exists', 409, 'order_already_exists');
    }
    const order: CfOrder = {
      cf_order_id: 1000 + this.seq++,
      order_id: body.order_id,
      order_amount: body.order_amount,
      order_currency: body.order_currency,
      order_status: 'ACTIVE',
      payment_session_id: `session_${body.order_id}`,
      order_expiry_time: body.order_expiry_time ?? '',
    };
    this.orders.set(order.order_id, order);
    return { ...order };
  }

  async getOrder(orderId: string): Promise<CfOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new CashfreeApiError('order not found', 404);
    return { ...order };
  }

  async getPayments(orderId: string): Promise<CfPayment[]> {
    return (this.payments.get(orderId) ?? []).map((p) => ({ ...p }));
  }

  async terminateOrder(orderId: string): Promise<CfOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new CashfreeApiError('order not found', 404);
    if (order.order_status !== 'ACTIVE') {
      throw new CashfreeApiError(`order is ${order.order_status}`, 400);
    }
    order.order_status = 'TERMINATED';
    return { ...order };
  }

  // ---- test helpers: simulate what happens on cashfree's side ----

  pay(orderId: string, status: CfPaymentStatus, amount?: number) {
    const order = this.orders.get(orderId)!;
    const list = this.payments.get(orderId) ?? [];
    const payment: CfPayment = {
      cf_payment_id: 5000 + this.seq++,
      order_id: orderId,
      payment_status: status,
      payment_amount: amount ?? order.order_amount,
      payment_currency: 'INR',
      payment_group: 'upi',
      payment_message: status === 'SUCCESS' ? 'Transaction successful' : `payment ${status}`,
      // each attempt one minute after the previous one
      payment_time: new Date(Date.UTC(2026, 9, 24, 10, list.length)).toISOString(),
      error_details:
        status === 'FAILED'
          ? { error_code: 'TRANSACTION_DECLINED', error_description: 'bank declined' }
          : null,
    };
    list.push(payment);
    this.payments.set(orderId, list);
    if (status === 'SUCCESS') order.order_status = 'PAID';
    return payment;
  }

  expire(orderId: string) {
    this.orders.get(orderId)!.order_status = 'EXPIRED';
  }
}
