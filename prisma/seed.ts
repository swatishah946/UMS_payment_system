import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// sample ERP data so the payment apis can be tried out
async function main() {
  const asha = await prisma.student.upsert({
    where: { rollNumber: 'CS2023001' },
    update: {},
    create: {
      rollNumber: 'CS2023001',
      name: 'Asha Verma',
      email: 'asha.verma@example.com',
      phone: '9999999999',
    },
  });

  const rahul = await prisma.student.upsert({
    where: { rollNumber: 'ME2023014' },
    update: {},
    create: {
      rollNumber: 'ME2023014',
      name: 'Rahul Nair',
      email: 'rahul.nair@example.com',
      phone: '9888888888',
    },
  });

  const count = await prisma.feeInvoice.count();
  if (count > 0) {
    console.log('invoices already seeded, skipping');
    return;
  }

  await prisma.feeInvoice.createMany({
    data: [
      { studentId: asha.id, title: 'Semester 5 Tuition Fee', feeType: 'TUITION', amount: 45000 },
      { studentId: asha.id, title: 'Hostel Fee Jul-Dec', feeType: 'HOSTEL', amount: 18500.5 },
      { studentId: asha.id, title: 'End Sem Exam Fee', feeType: 'EXAM', amount: 1200 },
      { studentId: rahul.id, title: 'Semester 5 Tuition Fee', feeType: 'TUITION', amount: 45000 },
      { studentId: rahul.id, title: 'Library Fine', feeType: 'FINE', amount: 150 },
    ],
  });

  const invoices = await prisma.feeInvoice.findMany({ include: { student: true } });
  console.table(
    invoices.map((i) => ({
      invoiceId: i.id,
      student: i.student.rollNumber,
      title: i.title,
      amount: i.amount.toString(),
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
