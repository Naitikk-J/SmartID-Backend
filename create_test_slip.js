const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const student = await prisma.student.findFirst();
  if (!student) { console.log('No student found'); return; }
  const slip = await prisma.pinkSlip.create({
    data: {
      studentId: student.id,
      reason: 'Testing visibility',
      fromDate: new Date(),
      toDate: new Date(Date.now() + 86400000),
      status: 'PENDING'
    }
  });
  console.log('CREATED SLIP:', JSON.stringify(slip, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
