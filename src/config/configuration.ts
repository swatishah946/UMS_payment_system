// public url of the app when deployed. render sets RENDER_EXTERNAL_URL automatically
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(
  /\/$/,
  '',
);

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  // protects admin routes when set (see AdminKeyGuard)
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  cashfree: {
    appId: process.env.CASHFREE_APP_ID ?? '',
    secretKey: process.env.CASHFREE_SECRET_KEY ?? '',
    env: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
    apiVersion: process.env.CASHFREE_API_VERSION ?? '2026-01-01',
  },
  payment: {
    // explicit values win, otherwise derive them from the public url (if deployed)
    returnUrl:
      process.env.PAYMENT_RETURN_URL || (publicUrl ? `${publicUrl}/?order_id={order_id}` : ''),
    notifyUrl:
      process.env.PAYMENT_NOTIFY_URL || (publicUrl ? `${publicUrl}/webhooks/cashfree` : ''),
    orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES ?? '30', 10),
  },
});
