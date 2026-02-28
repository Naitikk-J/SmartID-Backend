const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('🚀 Starting Role Migration...');

    // 1. DEPT_ADMIN -> HOD
    const deptAdminCount = await prisma.adminUser.updateMany({
        where: { role: 'DEPT_ADMIN' },
        data: { role: 'HOD' },
    });
    console.log(`✅ Migrated ${deptAdminCount.count} DEPT_ADMIN to HOD`);

    // 2. MODULE_ADMIN -> FACULTY
    const moduleAdminCount = await prisma.adminUser.updateMany({
        where: { role: 'MODULE_ADMIN' },
        data: { role: 'FACULTY' },
    });
    console.log(`✅ Migrated ${moduleAdminCount.count} MODULE_ADMIN to FACULTY`);

    // 3. OPERATOR -> SECURITY_GUARD
    const operatorCount = await prisma.adminUser.updateMany({
        where: { role: 'OPERATOR' },
        data: { role: 'SECURITY_GUARD' },
    });
    console.log(`✅ Migrated ${operatorCount.count} OPERATOR to SECURITY_GUARD`);

    console.log('🎉 Role Migration Complete!');
}

main()
    .catch((e) => {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
