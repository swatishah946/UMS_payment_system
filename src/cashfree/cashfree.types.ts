// only the fields we actually use from cashfree's responses

export type CfOrderStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED';

export type CfPaymentStatus =
  'SUCCESS' | 'NOT_ATTEMPTED' | 'FAILED' | 'USER_DROPPED' | 'VOID' | 'CANCELLED' | 'PENDING';

export interface CfCreateOrderRequest {
  order_id: string;
  order_amount: number;
  order_currency: string;
  customer_details: {
    customer_id: string;
    customer_phone: string;
    customer_email?: string;
    customer_name?: string;
  };
  order_meta?: {
    return_url?: string;
    notify_url?: string;
  };
  order_expiry_time?: string;
  order_note?: string;
  order_tags?: Record<string, string>;
}

export interface CfOrder {
  cf_order_id: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: CfOrderStatus;
  payment_session_id: string;
  order_expiry_time: string;
}

export interface CfPayment {
  cf_payment_id: string | number;
  order_id: string;
  payment_status: CfPaymentStatus;
  payment_amount: number;
  payment_currency: string;
  payment_message?: string;
  payment_time?: string;
  payment_completion_time?: string;
  payment_group?: string;
  bank_reference?: string;
  error_details?: {
    error_code?: string;
    error_description?: string;
    error_reason?: string;
    error_source?: string;
  } | null;
}

export interface CfWebhookPayload {
  type: string; // PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK ...
  event_time: string;
  data: {
    order?: { order_id: string; order_amount: number; order_currency: string };
    payment?: CfPayment;
    error_details?: CfPayment['error_details'];
  };
}
