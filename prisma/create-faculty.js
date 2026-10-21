const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();

async function createFaculty() {
    const name = process.env.FACULTY_SEED_NAME;
    const email = process.env.FACULTY_SEED_EMAIL;
    const password = process.env.FACULTY_SEED_PASSWORD;
    const role = "FACULTY";
    const department = process.env.FACULTY_SEED_DEPARTMENT;
    if (!name || !email || !password || !department) {
        throw new Error("Set FACULTY_SEED_NAME, FACULTY_SEED_EMAIL, FACULTY_SEED_PASSWORD, FACULTY_SEED_DEPARTMENT");
    }

    console.log('--- Faculty Creation Script ---');
    console.log(`Target Email: ${email}`);

    try {
        // Check if user already exists
        const existing = await prisma.adminUser.findUnique({
            where: { email }
        });

        if (existing) {
            console.log('User already exists. Updating role and password...');
            const passwordHash = await bcrypt.hash(password, 12);
            await prisma.adminUser.update({
                where: { email },
                data: {
                    passwordHash,
                    role,
                    name,
                    department,
                    isActive: true
                }
            });
            console.log('User updated successfully.');
        } else {
            console.log('Creating new faculty user...');
            const passwordHash = await bcrypt.hash(password, 12);
            await prisma.adminUser.create({
                data: {
                    name,
                    email,
                    passwordHash,
                    role,
                    department,
                    isActive: true
                }
            });
            console.log('Faculty user created successfully.');
        }

    } catch (err) {
        console.error('Error creating faculty:', err);
    } finally {
        await prisma.$disconnect();
    }
}

createFaculty();
