const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const slips = await prisma.pinkSlip.findMany({});
  console.log('ALL SLIPS COUNT:', slips.length);
  const pending = slips.filter(s => s.status === 'PENDING');
  console.log('PENDING SLIPS COUNT:', pending.length);
}
main().catch(console.error).finally(() => prisma.$disconnect());
