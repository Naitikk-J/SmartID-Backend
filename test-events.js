const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const events = await prisma.campusEvent.findMany({
    select: { id: true, name: true, isActive: true, endTime: true, appliesTo: true }
  });
  console.log("ALL EVENTS:", JSON.stringify(events, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
