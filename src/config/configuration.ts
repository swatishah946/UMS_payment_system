export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  cashfree: {
    appId: process.env.CASHFREE_APP_ID ?? '',
    secretKey: process.env.CASHFREE_SECRET_KEY ?? '',
    env: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
    apiVersion: process.env.CASHFREE_API_VERSION ?? '2026-01-01',
  },
  payment: {
    returnUrl: process.env.PAYMENT_RETURN_URL ?? '',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL ?? '',
    orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES ?? '30', 10),
  },
});
