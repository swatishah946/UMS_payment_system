import { Module } from '@nestjs/common';
import { CashfreeModule } from '../cashfree/cashfree.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [CashfreeModule, PaymentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
