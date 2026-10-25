// runs in every test worker before the app is loaded.
// points the app at a separate test database so tests never touch dev data
const base =
  process.env.DATABASE_URL_TEST ?? 'postgresql://ums:ums@localhost:5433/ums_payments_test';

process.env.DATABASE_URL = base;
process.env.CASHFREE_APP_ID = 'test_app';
process.env.CASHFREE_SECRET_KEY = 'test_secret';
process.env.CASHFREE_ENV = 'sandbox';
process.env.PAYMENT_RETURN_URL = 'http://localhost:5173/payment/status?order_id={order_id}';
process.env.PAYMENT_NOTIFY_URL = '';
process.env.ORDER_EXPIRY_MINUTES = '30';
process.env.ADMIN_API_KEY = 'test_admin_key';
