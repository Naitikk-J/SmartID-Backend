const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
    try {
        console.log('🌱 Seeding default gate...');

        // 1. Create Main Gate if it doesn't exist
        let gate = await prisma.gate.findFirst({
            where: { name: 'Main Gate' }
        });

        if (!gate) {
            gate = await prisma.gate.create({
                data: {
                    name: 'Main Gate',
                    location: 'Front Entrance',
                    isActive: true
                }
            });
            console.log('✅ Created Main Gate:', gate.id);
        } else {
            console.log('ℹ️ Main Gate already exists:', gate.id);
        }

        // 2. Assign this gate to all SECURITY_GUARD admins who don't have one
        const updatedAdmins = await prisma.adminUser.updateMany({
            where: {
                role: 'SECURITY_GUARD',
                gateId: null
            },
            data: {
                gateId: gate.id
            }
        });

        console.log(`✅ Assigned gate to ${updatedAdmins.count} security guards.`);

        // 3. Output for Flutter app reference (optional but helpful)
        console.log('\n--- REFERENCE FOR FLUTTER ---');
        console.log('GATE_ID:', gate.id);
        console.log('-----------------------------\n');

    } catch (error) {
        console.error('❌ Seeding failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

seed();
