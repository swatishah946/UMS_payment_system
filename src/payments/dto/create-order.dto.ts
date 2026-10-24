import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ description: 'Fee invoice to pay' })
  @IsUUID()
  invoiceId: string;

  @ApiProperty({ description: 'Student paying the invoice (must own the invoice)' })
  @IsUUID()
  studentId: string;
}
