const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();

async function createFaculty() {
    const name = "REDACTED";
    const email = "REDACTED";
    const password = "REDACTED";
    const role = "FACULTY";
    const department = "REDACTED";

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
