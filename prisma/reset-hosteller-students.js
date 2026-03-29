const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const HOSTELLER_STUDENTS = [
    {
        enrollmentNo: '0101CS221002',
        fullName: 'Ananya Sharma',
        email: '0101cs221002@mits.ac.in',
        phone: '9000000002',
        department: 'CSE',
        year: 2,
        studentType: 'HOSTELLER_GIRLS',
    },
    {
        enrollmentNo: '0101IT221045',
        fullName: 'Rahul Kumar',
        email: '0101it221045@mits.ac.in',
        phone: '9000000003',
        department: 'IT',
        year: 2,
        studentType: 'HOSTELLER_BOYS',
    },
    {
        enrollmentNo: '0101EC221012',
        fullName: 'Priya Singh',
        email: '0101ec221012@mits.ac.in',
        phone: '9000000004',
        department: 'EC',
        year: 2,
        studentType: 'HOSTELLER_GIRLS',
    },
    {
        enrollmentNo: '0101ME221023',
        fullName: 'Arjun Patel',
        email: '0101me221023@mits.ac.in',
        phone: '9000000005',
        department: 'ME',
        year: 2,
        studentType: 'HOSTELLER_BOYS',
    },
];

async function main() {
    console.log('Resetting student data and reseeding hostellers...');

    // Remove student-linked data first.
    await prisma.pinkSlip.deleteMany({});
    await prisma.faceDetectionLog.deleteMany({});
    await prisma.faceData.deleteMany({});
    await prisma.vote.deleteMany({});
    await prisma.libraryTransaction.deleteMany({});
    await prisma.attendanceRecord.deleteMany({});
    await prisma.exitEvent.deleteMany({});
    await prisma.scanEvent.deleteMany({});
    await prisma.card.deleteMany({});
    await prisma.student.deleteMany({});

    for (const student of HOSTELLER_STUDENTS) {
        const passwordHash = await bcrypt.hash(student.phone, 12);

        await prisma.student.create({
            data: {
                ...student,
                passwordHash,
                cards: {
                    create: {
                        cardUid: `CARD_${student.enrollmentNo}`,
                        qrToken: `TOKEN_${student.enrollmentNo}`,
                    },
                },
            },
        });
    }

    console.log(`Reseeded ${HOSTELLER_STUDENTS.length} hosteller students.`);
    console.log('Student app password = phone number for each seeded student.');
}

main()
    .catch((err) => {
        console.error('Student reset failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
