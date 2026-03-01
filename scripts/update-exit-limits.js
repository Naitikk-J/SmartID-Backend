// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Update Exit Limits Migration Script
// Increases hosteller maxExits from 1 to 2 for all days
// ═══════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('🚀 Starting Exit Limit Migration...');

    const result = await prisma.exitRule.updateMany({
        where: {
            studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
            maxExits: 1
        },
        data: {
            maxExits: 2
        }
    });

    console.log(`✅ Updated ${result.count} exit rules for hostellers.`);
}

main()
    .catch((e) => {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
