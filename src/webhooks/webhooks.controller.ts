import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // called by cashfree, not by our frontend
  @Post('cashfree')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cashfree payment webhook (called by Cashfree, not by the frontend)',
    description:
      'Verifies the signature, dedupes retries and re-syncs the order from Cashfree. ' +
      'Handles PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK and PAYMENT_USER_DROPPED_WEBHOOK.',
  })
  @ApiHeader({
    name: 'x-webhook-signature',
    description: 'base64 HMAC-SHA256 of timestamp + raw body',
  })
  @ApiHeader({ name: 'x-webhook-timestamp' })
  @ApiHeader({ name: 'x-idempotency-key', required: false, description: 'used to dedupe retries' })
  @ApiBody({
    schema: {
      example: {
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        event_time: '2026-10-24T20:00:00+05:30',
        data: {
          order: { order_id: 'UMS_MVMQETSD_B12F01F0', order_amount: 150 },
          payment: { cf_payment_id: '5114910543', payment_status: 'SUCCESS' },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Handled (also for duplicates and unknown orders)' })
  @ApiResponse({ status: 401, description: 'INVALID_SIGNATURE' })
  @ApiResponse({ status: 503, description: 'Processing failed, Cashfree will retry' })
  handleCashfree(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature?: string,
    @Headers('x-webhook-timestamp') timestamp?: string,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    // signature is computed over the exact bytes cashfree sent, so use the raw body
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    return this.webhooks.handleCashfree(rawBody, { signature, timestamp, idempotencyKey });
  }
}
