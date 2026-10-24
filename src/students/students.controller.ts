import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

// read-only views the ERP / student portal needs around payments
@ApiTags('students')
@Controller('students/:studentId')
export class StudentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('invoices')
  @ApiOperation({ summary: 'Fee invoices of a student with their payment status' })
  async invoices(@Param('studentId', ParseUUIDPipe) studentId: string) {
    await this.ensureStudent(studentId);
    return this.prisma.feeInvoice.findMany({
      where: { studentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get('payments')
  @ApiOperation({ summary: 'Payment history of a student (all orders, newest first)' })
  async payments(@Param('studentId', ParseUUIDPipe) studentId: string) {
    await this.ensureStudent(studentId);
    return this.prisma.paymentOrder.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        status: true,
        amount: true,
        currency: true,
        paidAt: true,
        failureReason: true,
        createdAt: true,
        invoice: { select: { id: true, title: true, feeType: true } },
        transactions: {
          orderBy: { createdAt: 'asc' },
          select: { cfPaymentId: true, status: true, paymentGroup: true, paymentTime: true },
        },
      },
    });
  }

  private async ensureStudent(id: string) {
    const exists = await this.prisma.student.count({ where: { id } });
    if (!exists) {
      throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    }
  }
}
