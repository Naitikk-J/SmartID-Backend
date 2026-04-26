const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const gates = await prisma.gate.findMany({
    select: { id: true, name: true }
  });
  console.log("GATES:", JSON.stringify(gates, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
