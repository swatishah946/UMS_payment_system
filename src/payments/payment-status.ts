import { PaymentOrderStatus as S } from '@prisma/client';
import { CfOrderStatus, CfPayment } from '../cashfree/cashfree.types';

// statuses where the student can still pay on this order
export const OPEN_STATUSES: S[] = [S.CREATED, S.ACTIVE, S.PENDING, S.FAILED, S.USER_DROPPED];

export const FINAL_STATUSES: S[] = [S.PAID, S.EXPIRED, S.CANCELLED, S.FLAGGED];

const ALLOWED: Record<S, S[]> = {
  [S.CREATED]: [S.ACTIVE, S.EXPIRED, S.CANCELLED],
  [S.ACTIVE]: [S.PENDING, S.FAILED, S.USER_DROPPED, S.PAID, S.EXPIRED, S.CANCELLED, S.FLAGGED],
  // cancelling is not allowed while the bank is still processing a payment
  [S.PENDING]: [S.FAILED, S.USER_DROPPED, S.PAID, S.EXPIRED, S.FLAGGED],
  // a failed or dropped attempt can be retried on the same cashfree order
  [S.FAILED]: [S.PENDING, S.USER_DROPPED, S.PAID, S.EXPIRED, S.CANCELLED, S.FLAGGED],
  [S.USER_DROPPED]: [S.PENDING, S.FAILED, S.PAID, S.EXPIRED, S.CANCELLED, S.FLAGGED],
  // money can still land after we expired/cancelled locally (race with the bank),
  // we must record it instead of losing it
  [S.EXPIRED]: [S.PAID, S.FLAGGED],
  [S.CANCELLED]: [S.PAID, S.FLAGGED],
  [S.PAID]: [],
  [S.FLAGGED]: [],
};

export function canTransition(from: S, to: S): boolean {
  return ALLOWED[from].includes(to);
}

export function isOpen(status: S) {
  return OPEN_STATUSES.includes(status);
}

/**
 * Works out what our order status should be from what cashfree reports.
 * A successful payment always wins, otherwise the order status, otherwise
 * the most recent payment attempt.
 */
export function deriveStatus(cfOrderStatus: CfOrderStatus, payments: CfPayment[]): S {
  if (payments.some((p) => p.payment_status === 'SUCCESS') || cfOrderStatus === 'PAID') {
    return S.PAID;
  }
  if (cfOrderStatus === 'EXPIRED') return S.EXPIRED;
  if (cfOrderStatus === 'TERMINATED' || cfOrderStatus === 'TERMINATION_REQUESTED') {
    return S.CANCELLED;
  }

  const latest = latestPayment(payments);
  if (!latest) return S.ACTIVE;

  switch (latest.payment_status) {
    case 'PENDING':
      return S.PENDING;
    case 'USER_DROPPED':
      return S.USER_DROPPED;
    case 'FAILED':
    case 'CANCELLED':
    case 'VOID':
      return S.FAILED;
    default:
      return S.ACTIVE; // NOT_ATTEMPTED
  }
}

export function latestPayment(payments: CfPayment[]): CfPayment | undefined {
  return [...payments].sort((a, b) => time(b) - time(a))[0];
}

function time(p: CfPayment) {
  return p.payment_time ? new Date(p.payment_time).getTime() : 0;
}
