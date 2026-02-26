const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();

async function createSuperAdmin() {
    const name = "System Superadmin";
    const email = "admin@mits.ac.in";
    const password = "mits_secret_2026"; // Ensure this is changed in production
    const role = "SUPER_ADMIN";

    console.log('--- Superadmin Creation Script ---');
    console.log(`Target Email: ${email}`);

    try {
        // Check if user already exists
        const existing = await prisma.adminUser.findUnique({
            where: { email }
        });

        if (existing) {
            console.log('User already exists. Updating password...');
            const passwordHash = await bcrypt.hash(password, 12);
            await prisma.adminUser.update({
                where: { email },
                data: { passwordHash, isActive: true }
            });
            console.log('User updated successfully.');
        } else {
            console.log('Creating new superadmin...');
            const passwordHash = await bcrypt.hash(password, 12);
            await prisma.adminUser.create({
                data: {
                    name,
                    email,
                    passwordHash,
                    role,
                    isActive: true
                }
            });
            console.log('Superadmin created successfully.');
        }

        // Verify/Create a Wallet for this user? No, AdminUsers don't have wallets in this schema.
        // But we should verify the user can login.

    } catch (err) {
        console.error('Error creating superadmin:', err);
    } finally {
        await prisma.$disconnect();
    }
}

createSuperAdmin();
