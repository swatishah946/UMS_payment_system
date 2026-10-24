import { Module } from '@nestjs/common';
import { CashfreeModule } from '../cashfree/cashfree.module';
import { PaymentsController, ReconciliationController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [CashfreeModule],
  controllers: [PaymentsController, ReconciliationController],
  providers: [PaymentsService, ReconciliationService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
