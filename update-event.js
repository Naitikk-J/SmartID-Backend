const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 5); // Add 5 days

  const updated = await prisma.campusEvent.updateMany({
    data: {
      endTime: futureDate,
    }
  });
  console.log("Updated events:", updated.count);
}
main().catch(console.error).finally(() => prisma.$disconnect());
