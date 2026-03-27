const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  console.log('Connecting to DB...');
  await prisma.$connect();
  console.log('Connected.');
  const count = await prisma.pinkSlip.count();
  console.log('TOTAL PINK SLIPS:', count);
  const slips = await prisma.pinkSlip.findMany({ 
    take: 10,
    include: { student: { select: { fullName: true, email: true } } }
  });
  console.log('LATEST SLIPS:', JSON.stringify(slips, null, 2));
}
main().catch(err => {
  console.error('DB ERROR:', err);
}).finally(() => prisma.$disconnect());
