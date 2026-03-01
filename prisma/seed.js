// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Database Seed Script (MongoDB Version)
// ═══════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Starting database seed for MongoDB...');

    // 1. Clean existing data
    await prisma.auditLog.deleteMany({});
    await prisma.vote.deleteMany({});
    await prisma.libraryTransaction.deleteMany({});
    await prisma.book.deleteMany({});
    await prisma.walletTransaction.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.attendanceRecord.deleteMany({});
    await prisma.attendanceSession.deleteMany({});
    await prisma.timetableSlot.deleteMany({});
    await prisma.subject.deleteMany({});
    await prisma.exitEvent.deleteMany({});
    await prisma.scanEvent.deleteMany({});
    await prisma.exitRule.deleteMany({});
    await prisma.campusEvent.deleteMany({});
    await prisma.gate.deleteMany({});
    await prisma.card.deleteMany({});
    await prisma.adminUser.deleteMany({});
    await prisma.student.deleteMany({});

    console.log('🧹 Database cleaned.');

    // 2. Default Admin User
    const passwordHash = await bcrypt.hash('Admin@123', 12);
    const admin = await prisma.adminUser.create({
        data: {
            name: 'Super Admin',
            email: 'admin@mits.ac.in',
            passwordHash,
            role: 'SUPER_ADMIN',
        },
    });
    console.log('👤 Admin user created.');

    // 3. Campus Gates
    const gate1 = await prisma.gate.create({ data: { name: 'Main Gate 1', location: 'Near Entrance' } });
    const gate2 = await prisma.gate.create({ data: { name: 'Library Gate', location: 'Academic Block' } });
    console.log('🚪 Gates created.');

    // 4. Exit Rules
    const studentTypes = ['DAY_SCHOLAR', 'HOSTELLER_BOYS', 'HOSTELLER_GIRLS'];
    for (const type of studentTypes) {
        for (let day = 1; day <= 7; day++) {
            await prisma.exitRule.create({
                data: {
                    studentType: type,
                    dayOfWeek: day,
                    maxExits: type === 'DAY_SCHOLAR' ? -1 : 2, // -1 = Unlimited, Hostellers = 2
                    updatedById: admin.id,
                },
            });
        }
    }
    console.log('📜 Exit rules created.');

    // 5. Sample Students with Cards & Wallets
    const students = [
        { enrollment: '0101CS221001', name: 'Naitik Varshney', type: 'DAY_SCHOLAR', dept: 'CSE' },
        { enrollment: '0101CS221002', name: 'Ananya Sharma', type: 'HOSTELLER_GIRLS', dept: 'CSE' },
        { enrollment: '0101IT221045', name: 'Rahul Kumar', type: 'HOSTELLER_BOYS', dept: 'IT' },
    ];

    for (const s of students) {
        const student = await prisma.student.create({
            data: {
                enrollmentNo: s.enrollment,
                fullName: s.name,
                email: `${s.enrollment.toLowerCase()}@mits.ac.in`,
                studentType: s.type,
                department: s.dept,
                year: 2,
                wallet: { create: { balance: 1000 } },
                cards: {
                    create: {
                        cardUid: `CARD_${s.enrollment}`,
                        qrToken: `TOKEN_${s.enrollment}`, // In produce this is the AES encrypted payload
                    },
                },
            },
        });
        console.log(`👨‍🎓 Student created: ${s.name}`);
    }

    // 6. Subjects & Faculty
    const facultyHash = await bcrypt.hash('Faculty@123', 12);
    const faculty = await prisma.adminUser.create({
        data: {
            name: 'Prof. Sharma',
            email: 'sharma@mits.ac.in',
            passwordHash: facultyHash,
            role: 'DEPT_ADMIN',
            department: 'CSE',
        },
    });

    const sub1 = await prisma.subject.create({
        data: {
            code: 'CS201',
            name: 'Data Structures',
            department: 'CSE',
            semester: 3,
            facultyId: faculty.id,
        },
    });
    console.log('📚 Subjects & Faculty created.');

    console.log('✅ Seeding complete!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
