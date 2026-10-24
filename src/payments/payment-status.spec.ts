import { PaymentOrderStatus as S } from '@prisma/client';
import { CfPayment } from '../cashfree/cashfree.types';
import { canTransition, deriveStatus } from './payment-status';

const pay = (status: CfPayment['payment_status'], time: string): CfPayment => ({
  cf_payment_id: Math.random().toString(),
  order_id: 'UMS_1',
  payment_status: status,
  payment_amount: 100,
  payment_currency: 'INR',
  payment_time: time,
});

describe('canTransition', () => {
  it('allows normal happy path', () => {
    expect(canTransition(S.CREATED, S.ACTIVE)).toBe(true);
    expect(canTransition(S.ACTIVE, S.PENDING)).toBe(true);
    expect(canTransition(S.PENDING, S.PAID)).toBe(true);
  });

  it('never moves a paid order', () => {
    for (const to of Object.values(S)) {
      expect(canTransition(S.PAID, to)).toBe(false);
    }
  });

  it('lets student retry after a failure or drop', () => {
    expect(canTransition(S.FAILED, S.PENDING)).toBe(true);
    expect(canTransition(S.USER_DROPPED, S.PAID)).toBe(true);
  });

  it('does not cancel while payment is pending', () => {
    expect(canTransition(S.PENDING, S.CANCELLED)).toBe(false);
  });

  it('accepts late success on expired/cancelled order', () => {
    expect(canTransition(S.EXPIRED, S.PAID)).toBe(true);
    expect(canTransition(S.CANCELLED, S.PAID)).toBe(true);
    expect(canTransition(S.EXPIRED, S.ACTIVE)).toBe(false);
  });
});

describe('deriveStatus', () => {
  it('is ACTIVE when nothing attempted yet', () => {
    expect(deriveStatus('ACTIVE', [])).toBe(S.ACTIVE);
  });

  it('is PAID if any attempt succeeded, even if a later one failed', () => {
    const payments = [pay('SUCCESS', '2026-10-24T10:00:00Z'), pay('FAILED', '2026-10-24T10:05:00Z')];
    expect(deriveStatus('ACTIVE', payments)).toBe(S.PAID);
  });

  it('uses the latest attempt otherwise', () => {
    const payments = [pay('FAILED', '2026-10-24T10:00:00Z'), pay('PENDING', '2026-10-24T10:02:00Z')];
    expect(deriveStatus('ACTIVE', payments)).toBe(S.PENDING);
    expect(deriveStatus('ACTIVE', [pay('USER_DROPPED', '2026-10-24T10:00:00Z')])).toBe(
      S.USER_DROPPED,
    );
    expect(deriveStatus('ACTIVE', [pay('VOID', '2026-10-24T10:00:00Z')])).toBe(S.FAILED);
  });

  it('maps cashfree order states', () => {
    expect(deriveStatus('EXPIRED', [])).toBe(S.EXPIRED);
    expect(deriveStatus('TERMINATED', [])).toBe(S.CANCELLED);
    expect(deriveStatus('PAID', [])).toBe(S.PAID);
  });
});
