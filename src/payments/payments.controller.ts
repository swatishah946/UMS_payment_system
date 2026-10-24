import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StatusSource } from '@prisma/client';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments/orders')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create (or reuse) a payment order for a fee invoice' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Same key returns the same order, use one per "Pay" click',
  })
  create(@Body() dto: CreateOrderDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.payments.createOrder(dto, idempotencyKey?.trim() || undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order by our uuid or merchant order id (UMS_...)' })
  get(@Param('id') id: string) {
    return this.payments.getOrder(id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-check the order with cashfree, call after checkout returns' })
  async verify(@Param('id') id: string) {
    const order = await this.payments.getOrder(id);
    await this.payments.syncOrder(order.id, StatusSource.VERIFY);
    return this.payments.getOrder(order.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unpaid order (admin / ERP)' })
  cancel(@Param('id') id: string, @Body() dto: CancelOrderDto) {
    return this.payments.cancelOrder(id, dto.reason);
  }
}
