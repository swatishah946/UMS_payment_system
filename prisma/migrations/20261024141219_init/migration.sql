-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED', 'PAID', 'EXPIRED', 'CANCELLED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUCCESS', 'NOT_ATTEMPTED', 'FAILED', 'USER_DROPPED', 'VOID', 'CANCELLED', 'PENDING');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "StatusSource" AS ENUM ('API', 'WEBHOOK', 'VERIFY', 'RECONCILE', 'ADMIN');

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "roll_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoices" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "fee_type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "due_date" TIMESTAMP(3),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "paid_at" TIMESTAMP(3),
    "paid_order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "order_id" TEXT NOT NULL,
    "cf_order_id" TEXT,
    "invoice_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'CREATED',
    "payment_session_id" TEXT,
    "idempotency_key" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "cf_payment_id" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "payment_group" TEXT,
    "bank_reference" TEXT,
    "payment_message" TEXT,
    "error_code" TEXT,
    "error_reason" TEXT,
    "payment_time" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "event_type" TEXT,
    "order_id" TEXT,
    "cf_payment_id" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_history" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "from_status" "PaymentOrderStatus",
    "to_status" "PaymentOrderStatus" NOT NULL,
    "source" "StatusSource" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "students_roll_number_key" ON "students"("roll_number");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoices_paid_order_id_key" ON "fee_invoices"("paid_order_id");

-- CreateIndex
CREATE INDEX "fee_invoices_student_id_idx" ON "fee_invoices"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_order_id_key" ON "payment_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_cf_order_id_key" ON "payment_orders"("cf_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_idempotency_key_key" ON "payment_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_orders_invoice_id_idx" ON "payment_orders"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_orders_student_id_idx" ON "payment_orders"("student_id");

-- CreateIndex
CREATE INDEX "payment_orders_status_updated_at_idx" ON "payment_orders"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_cf_payment_id_key" ON "payment_transactions"("cf_payment_id");

-- CreateIndex
CREATE INDEX "payment_transactions_payment_order_id_idx" ON "payment_transactions"("payment_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_key_key" ON "webhook_events"("event_key");

-- CreateIndex
CREATE INDEX "webhook_events_order_id_idx" ON "webhook_events"("order_id");

-- CreateIndex
CREATE INDEX "payment_status_history_payment_order_id_idx" ON "payment_status_history"("payment_order_id");

-- AddForeignKey
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "fee_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand written: prisma schema can't express these.

-- Only one open (payable) order per invoice. Protects against two
-- concurrent "pay" requests both creating a cashfree order.
CREATE UNIQUE INDEX "payment_orders_one_open_per_invoice"
  ON "payment_orders" ("invoice_id")
  WHERE "status" IN ('CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED');

ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amount_min" CHECK ("amount" >= 1);
