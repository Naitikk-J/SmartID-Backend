const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const slips = await prisma.pinkSlip.findMany({ include: { student: true } });
  console.log(JSON.stringify(slips, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
