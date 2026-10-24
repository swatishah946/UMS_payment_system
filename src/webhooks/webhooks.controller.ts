import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // called by cashfree, not by our frontend
  @Post('cashfree')
  @HttpCode(200)
  @ApiExcludeEndpoint()
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
