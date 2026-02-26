const { PrismaClient } = require('@prisma/client');
const dotenv = require('dotenv');

dotenv.config();
const prisma = new PrismaClient();

async function startTestSession() {
    const facultyEmail = "REDACTED";
    const subjectCode = "CS101";

    console.log('--- Start Test Attendance Session ---');

    try {
        const faculty = await prisma.adminUser.findUnique({ where: { email: facultyEmail } });
        if (!faculty) throw new Error('Faculty not found. Run create-faculty.js first.');

        // 1. Ensure Subject exists
        let subject = await prisma.subject.findUnique({ where: { code: subjectCode } });
        if (!subject) {
            console.log(`Creating subject ${subjectCode}...`);
            subject = await prisma.subject.create({
                data: {
                    code: subjectCode,
                    name: "Introduction to Programming",
                    department: "REDACTED",
                    semester: 1,
                    facultyId: faculty.id
                }
            });
        }

        // 2. Clear previous open sessions for this faculty
        await prisma.attendanceSession.updateMany({
            where: { facultyId: faculty.id, status: 'OPEN' },
            data: { status: 'CLOSED', closedAt: new Date() }
        });

        // 3. Start new session
        const session = await prisma.attendanceSession.create({
            data: {
                subjectId: subject.id,
                facultyId: faculty.id,
                status: 'OPEN',
                windowMinutes: 60 // 1 hour for testing
            }
        });

        console.log('Session started successfully!');
        console.log('Session ID:', session.id);
        console.log('Faculty:', faculty.name);
        console.log('Subject:', subject.name);
        console.log('Valid for: 60 minutes');

    } catch (err) {
        console.error('Error starting session:', err.message);
    } finally {
        await prisma.$disconnect();
    }
}

startTestSession();
