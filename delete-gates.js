const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Delete events first if there are FK constraints
    await prisma.scanEvent.deleteMany();
    const deleted = await prisma.gate.deleteMany();
    console.log("Deleted gates:", deleted.count);
    
    const remaining = await prisma.gate.findMany();
    console.log("Remaining gates:", remaining.map(g => g.name));
  } catch (err) {
    console.error(err);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
