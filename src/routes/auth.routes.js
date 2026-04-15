// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Auth Routes
// POST /login, /refresh, /logout, GET /me
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config/env');
const prisma = require('../config/database');
const { authenticate, redis } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { loginRateLimit } = require('../middleware/rateLimit');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');
const { sendPush } = require('../services/notification.service');

const router = express.Router();

const HARD_CODED_TEST_STUDENT_EMAIL = 'student.test@mits.local';
const HARD_CODED_TEST_STUDENT_PASSWORD = 'Student@123';

// ── Validation schemas ───────────────────────────────────────
const loginSchema = z.object({
    email: z.string().email('Valid email required'),
    password: z.string().min(1, 'Password required'),
    deviceId: z.string().trim().min(6).max(128).optional(),
    deviceLabel: z.string().trim().max(120).optional(),
    devicePlatform: z.string().trim().max(40).optional(),
});

const refreshSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token required'),
});

const updateStudentDeviceSchema = z.object({
    deviceId: z.string().trim().min(6).max(128).optional(),
    deviceLabel: z.string().trim().min(1).max(120).optional(),
    devicePlatform: z.string().trim().min(1).max(40).optional(),
});

const requestStudentDeviceRebindSchema = z.object({
    requestedDeviceId: z.string().trim().min(6).max(128),
    requestedDeviceLabel: z.string().trim().max(120).optional(),
    requestedDevicePlatform: z.string().trim().max(40).optional(),
    reason: z.string().trim().max(240).optional(),
});

function assertAuthRuntimeConfig() {
    if (!config.DATABASE_URL) {
        throw new AppError('Authentication service is temporarily unavailable', 503, 'AUTH_CONFIG_MISSING');
    }
}

// ── Helper: generate tokens ─────────────────────────────────
function generateTokens(user) {
    const payload = {
        id: user.id,
        email: user.email,
        role: user.role,
        department: user.department,
        module: user.module,
    };
    const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    const refreshToken = jwt.sign({ id: user.id, type: 'refresh' }, config.JWT_SECRET, {
        expiresIn: config.JWT_REFRESH_EXPIRES_IN,
    });
    return { accessToken, refreshToken };
}

function cleanString(value, maxLength = 128) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}

function resolveClientIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
        return String(forwardedFor[0]).split(',')[0].trim();
    }
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
        return forwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || null;
}

function resolveDeviceContext(req) {
    return {
        deviceId: cleanString(req.body?.deviceId || req.headers['x-device-id'], 128),
        deviceLabel: cleanString(req.body?.deviceLabel || req.headers['x-device-label'], 120),
        devicePlatform: cleanString(req.body?.devicePlatform || req.headers['x-device-platform'], 40),
        userAgent: cleanString(req.headers['user-agent'], 255),
    };
}

async function createStudentAuthLogSafe(payload) {
    try {
        await prisma.studentAuthLog.create({ data: payload });
    } catch (err) {
        console.warn('⚠️ Failed to write StudentAuthLog:', err.message);
    }
}

let cachedSystemActorId = null;

async function resolveSystemActorId() {
    if (cachedSystemActorId) return cachedSystemActorId;

    const systemActor = await prisma.adminUser.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
    });

    cachedSystemActorId = systemActor?.id || null;
    return cachedSystemActorId;
}

async function createStudentAlertSafe({
    studentId,
    title,
    body,
    actorId = null,
    targetId = null,
    targetType = 'GENERIC',
    screen = 'dashboard',
    ipAddress = null,
}) {
    try {
        const effectiveActorId = actorId || await resolveSystemActorId();
        if (!effectiveActorId) return null;

        const payload = {
            title,
            body,
            targetId,
            targetType,
            screen,
            type: 'STUDENT_ALERT',
        };

        const alert = await prisma.auditLog.create({
            data: {
                actorId: effectiveActorId,
                action: 'STUDENT_ALERT',
                entity: 'Student',
                entityId: studentId,
                ipAddress,
                newValue: payload,
            },
        });

        await sendPush({
            studentId,
            title,
            body,
            data: {
                type: 'STUDENT_ALERT',
                alertId: String(alert.id),
                targetId: targetId ? String(targetId) : '',
                targetType,
                screen,
            },
        });

        return alert;
    } catch (err) {
        console.warn('⚠️ Failed to create student alert:', err.message);
        return null;
    }
}

async function assertStudentDeviceBindingAllowed({ student, email, deviceContext, ipAddress }) {
    if (!deviceContext.deviceId) {
        await createStudentAuthLogSafe({
            studentId: student.id,
            studentEmail: student.email || email,
            enrollmentNo: student.enrollmentNo || null,
            action: 'LOGIN_BLOCKED_MISSING_DEVICE_ID',
            status: 'BLOCKED',
            reason: 'DEVICE_ID_REQUIRED',
            deviceLabel: deviceContext.deviceLabel,
            devicePlatform: deviceContext.devicePlatform,
            ipAddress,
            userAgent: deviceContext.userAgent,
            metadata: { email },
        });
        await createStudentAlertSafe({
            studentId: student.id,
            title: 'Login blocked on your account',
            body: 'A login attempt was blocked because the device identity was missing.',
            ipAddress,
        });
        throw new AppError('Device verification failed. Please login from the official student app.', 400, 'DEVICE_ID_REQUIRED');
    }

    if (student.linkedDeviceId && student.linkedDeviceId !== deviceContext.deviceId) {
        await createStudentAuthLogSafe({
            studentId: student.id,
            studentEmail: student.email || email,
            enrollmentNo: student.enrollmentNo || null,
            action: 'LOGIN_BLOCKED_STUDENT_LINKED_TO_OTHER_DEVICE',
            status: 'BLOCKED',
            reason: 'STUDENT_ALREADY_LINKED_TO_OTHER_DEVICE',
            deviceId: deviceContext.deviceId,
            deviceLabel: deviceContext.deviceLabel,
            devicePlatform: deviceContext.devicePlatform,
            ipAddress,
            userAgent: deviceContext.userAgent,
            metadata: {
                linkedDeviceId: student.linkedDeviceId,
            },
        });
        await createStudentAlertSafe({
            studentId: student.id,
            title: 'Suspicious login blocked',
            body: 'A login attempt was blocked because your ID is linked to another device.',
            ipAddress,
        });
        throw new AppError('This student ID is linked to another device. Contact admin to rebind.', 403, 'STUDENT_DEVICE_MISMATCH');
    }

    const conflictingStudent = await prisma.student.findFirst({
        where: {
            linkedDeviceId: deviceContext.deviceId,
            NOT: { id: student.id },
        },
        select: {
            id: true,
            fullName: true,
            enrollmentNo: true,
            email: true,
        },
    });

    if (conflictingStudent) {
        await createStudentAuthLogSafe({
            studentId: student.id,
            studentEmail: student.email || email,
            enrollmentNo: student.enrollmentNo || null,
            action: 'LOGIN_BLOCKED_DEVICE_LINKED_TO_OTHER_STUDENT',
            status: 'BLOCKED',
            reason: 'DEVICE_ALREADY_LINKED',
            deviceId: deviceContext.deviceId,
            deviceLabel: deviceContext.deviceLabel,
            devicePlatform: deviceContext.devicePlatform,
            linkedStudentId: conflictingStudent.id,
            linkedEnrollmentNo: conflictingStudent.enrollmentNo,
            ipAddress,
            userAgent: deviceContext.userAgent,
            metadata: {
                linkedStudentName: conflictingStudent.fullName,
                linkedStudentEmail: conflictingStudent.email,
            },
        });
        await createStudentAlertSafe({
            studentId: student.id,
            title: 'Device conflict detected',
            body: `Login blocked: this device is already linked to enrollment ${conflictingStudent.enrollmentNo}.`,
            ipAddress,
        });
        await createStudentAlertSafe({
            studentId: conflictingStudent.id,
            title: 'Another ID tried using your linked device',
            body: `A login attempt from your linked device was blocked for ${student.enrollmentNo || email}.`,
            ipAddress,
        });
        throw new AppError('This device is already linked with another student ID.', 403, 'DEVICE_ALREADY_LINKED');
    }
}

async function updateStudentDeviceOnLogin(student, deviceContext) {
    const now = new Date();
    const updateData = {
        lastLoginAt: now,
    };

    if (!student.linkedDeviceId && deviceContext.deviceId) {
        updateData.linkedDeviceId = deviceContext.deviceId;
        updateData.deviceLinkedAt = now;
    }
    if (deviceContext.deviceLabel) {
        updateData.linkedDeviceLabel = deviceContext.deviceLabel;
    }
    if (deviceContext.devicePlatform) {
        updateData.linkedDevicePlatform = deviceContext.devicePlatform;
    }

    return prisma.student.update({
        where: { id: student.id },
        data: updateData,
        select: {
            id: true,
            fullName: true,
            email: true,
            department: true,
            studentType: true,
            enrollmentNo: true,
            linkedDeviceId: true,
            linkedDeviceLabel: true,
            linkedDevicePlatform: true,
            deviceLinkedAt: true,
            lastLoginAt: true,
        },
    });
}

function mapStudentUserResponse(student) {
    return {
        id: student.id,
        name: student.fullName,
        email: student.email,
        role: 'STUDENT',
        department: student.department,
        module: null,
        studentType: student.studentType,
        enrollmentNo: student.enrollmentNo,
        linkedDeviceId: student.linkedDeviceId || null,
        linkedDeviceLabel: student.linkedDeviceLabel || null,
        linkedDevicePlatform: student.linkedDevicePlatform || null,
        deviceLinkedAt: student.deviceLinkedAt || null,
        lastLoginAt: student.lastLoginAt || null,
    };
}

// ── POST /login ─────────────────────────────────────────────
router.post('/login', loginRateLimit, validate(loginSchema), async (req, res, next) => {
    try {
        assertAuthRuntimeConfig();
        const { email, password } = req.body;
        const deviceContext = resolveDeviceContext(req);
        const ipAddress = resolveClientIp(req);

        // Testing shortcut: allow a fixed student-style login in non-production.
        // We provision/update a real admin user record so downstream role-protected APIs keep working.
        if (
            config.NODE_ENV !== 'production'
            && email === HARD_CODED_TEST_STUDENT_EMAIL
            && password === HARD_CODED_TEST_STUDENT_PASSWORD
        ) {
            const passwordHash = await bcrypt.hash(HARD_CODED_TEST_STUDENT_PASSWORD, 12);
            const user = await prisma.student.upsert({
                where: { email: HARD_CODED_TEST_STUDENT_EMAIL },
                update: {
                    fullName: 'Test Hosteller User',
                    passwordHash,
                    department: 'CSE',
                    year: 3,
                    studentType: 'HOSTELLER_BOYS',
                    isActive: true,
                },
                create: {
                    fullName: 'Test Hosteller User',
                    email: HARD_CODED_TEST_STUDENT_EMAIL,
                    enrollmentNo: '0901CSTEST',
                    department: 'CSE',
                    year: 3,
                    studentType: 'HOSTELLER_BOYS',
                    passwordHash,
                    isActive: true,
                },
            });

            await assertStudentDeviceBindingAllowed({
                student: user,
                email,
                deviceContext,
                ipAddress,
            });
            const updatedStudent = await updateStudentDeviceOnLogin(user, deviceContext);

            const tokens = generateTokens({
                id: updatedStudent.id,
                email: updatedStudent.email,
                role: 'STUDENT',
                department: updatedStudent.department,
                module: null,
            });

            await createStudentAuthLogSafe({
                studentId: updatedStudent.id,
                studentEmail: updatedStudent.email,
                enrollmentNo: updatedStudent.enrollmentNo,
                action: 'LOGIN_SUCCESS',
                status: 'SUCCESS',
                deviceId: deviceContext.deviceId,
                deviceLabel: deviceContext.deviceLabel,
                devicePlatform: deviceContext.devicePlatform,
                ipAddress,
                userAgent: deviceContext.userAgent,
            });

            return res.json({
                success: true,
                data: {
                    ...tokens,
                    user: {
                        ...mapStudentUserResponse(updatedStudent),
                        testUser: true,
                    },
                },
            });
        }

        let user = await prisma.adminUser.findUnique({ where: { email } });
        let isStudent = false;

        if (!user) {
            // Check student collection
            user = await prisma.student.findUnique({ where: { email } });
            if (user) {
                isStudent = true;
                // Students use enrollmentNo as name if fullName is missing, but fullName is required in schema
                user.name = user.fullName;
                user.role = 'STUDENT'; // Virtual role for token
            }
        }

        if (!user) {
            await createStudentAuthLogSafe({
                studentEmail: email,
                action: 'LOGIN_FAILURE',
                status: 'FAILED',
                reason: 'UNKNOWN_EMAIL',
                deviceId: deviceContext.deviceId,
                deviceLabel: deviceContext.deviceLabel,
                devicePlatform: deviceContext.devicePlatform,
                ipAddress,
                userAgent: deviceContext.userAgent,
            });
            throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
        }

        if (!user.isActive) {
            if (isStudent) {
                await createStudentAuthLogSafe({
                    studentId: user.id,
                    studentEmail: user.email,
                    enrollmentNo: user.enrollmentNo,
                    action: 'LOGIN_FAILURE',
                    status: 'FAILED',
                    reason: 'ACCOUNT_INACTIVE',
                    deviceId: deviceContext.deviceId,
                    deviceLabel: deviceContext.deviceLabel,
                    devicePlatform: deviceContext.devicePlatform,
                    ipAddress,
                    userAgent: deviceContext.userAgent,
                });
            }
            throw new AppError('Account is deactivated', 401, 'ACCOUNT_INACTIVE');
        }

        if (isStudent) {
            await assertStudentDeviceBindingAllowed({
                student: user,
                email,
                deviceContext,
                ipAddress,
            });
        }

        const passwordMatch = isStudent ? user.passwordHash : user.passwordHash;
        if (!passwordMatch) {
            if (isStudent) {
                await createStudentAuthLogSafe({
                    studentId: user.id,
                    studentEmail: user.email,
                    enrollmentNo: user.enrollmentNo,
                    action: 'LOGIN_FAILURE',
                    status: 'FAILED',
                    reason: 'LOGIN_DISABLED',
                    deviceId: deviceContext.deviceId,
                    deviceLabel: deviceContext.deviceLabel,
                    devicePlatform: deviceContext.devicePlatform,
                    ipAddress,
                    userAgent: deviceContext.userAgent,
                });
            }
            throw new AppError('Login not enabled for this account', 401, 'LOGIN_DISABLED');
        }

        const validPassword = await bcrypt.compare(password, passwordMatch);
        if (!validPassword) {
            if (isStudent) {
                await createStudentAuthLogSafe({
                    studentId: user.id,
                    studentEmail: user.email,
                    enrollmentNo: user.enrollmentNo,
                    action: 'LOGIN_FAILURE',
                    status: 'FAILED',
                    reason: 'INVALID_PASSWORD',
                    deviceId: deviceContext.deviceId,
                    deviceLabel: deviceContext.deviceLabel,
                    devicePlatform: deviceContext.devicePlatform,
                    ipAddress,
                    userAgent: deviceContext.userAgent,
                });
            } else {
                await logAction(req, {
                    action: 'LOGIN_FAILURE',
                    entity: 'AdminUser',
                    entityId: user.id,
                    userId: user.id,
                    newValue: { email, reason: 'Invalid password' }
                }).catch(() => { });
            }
            throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
        }

        let loginStudent = null;
        if (!isStudent) {
            await prisma.adminUser.update({
                where: { id: user.id },
                data: { lastLogin: new Date() },
            });
        } else {
            loginStudent = await updateStudentDeviceOnLogin(user, deviceContext);
        }

        const tokenUser = isStudent
            ? {
                id: loginStudent.id,
                email: loginStudent.email,
                role: 'STUDENT',
                department: loginStudent.department,
                module: null,
            }
            : user;

        const tokens = generateTokens(tokenUser);

        if (isStudent) {
            await createStudentAuthLogSafe({
                studentId: loginStudent.id,
                studentEmail: loginStudent.email,
                enrollmentNo: loginStudent.enrollmentNo,
                action: 'LOGIN_SUCCESS',
                status: 'SUCCESS',
                deviceId: deviceContext.deviceId,
                deviceLabel: deviceContext.deviceLabel,
                devicePlatform: deviceContext.devicePlatform,
                ipAddress,
                userAgent: deviceContext.userAgent,
            });
        } else {
            await logAction(req, {
                action: 'LOGIN_SUCCESS',
                entity: 'AdminUser',
                entityId: user.id,
                userId: user.id
            }).catch(() => { });
        }

        res.json({
            success: true,
            data: {
                ...tokens,
                user: {
                    ...(isStudent
                        ? mapStudentUserResponse(loginStudent)
                        : {
                            id: user.id,
                            name: user.name,
                            email: user.email,
                            role: user.role,
                            department: user.department,
                            module: user.module || null,
                            gateId: user.gateId || null,
                        }),
                    isStudent,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /refresh ───────────────────────────────────────────
router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
    try {
        assertAuthRuntimeConfig();
        const { refreshToken } = req.body;
        const decoded = jwt.verify(refreshToken, config.JWT_SECRET);

        if (decoded.type !== 'refresh') {
            throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
        }

        const user = await prisma.adminUser.findUnique({ where: { id: decoded.id } });
        if (!user || !user.isActive) {
            throw new AppError('User not found or inactive', 401, 'INVALID_TOKEN');
        }

        const tokens = generateTokens(user);

        res.json({
            success: true,
            data: { accessToken: tokens.accessToken },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /logout ────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
    try {
        const ipAddress = resolveClientIp(req);
        const deviceContext = resolveDeviceContext(req);

        // Add token to Redis blacklist with 8h TTL
        try {
            if (redis && typeof redis.set === 'function') {
                await redis.set(`blacklist:${req.token}`, '1', 'EX', 8 * 60 * 60);
            }
        } catch (redisErr) {
            console.warn('⚠️ Failed to blacklist token in Redis on logout (skipping):', redisErr.message);
        }

        if (req.user.role === 'STUDENT') {
            const student = await prisma.student.update({
                where: { id: req.user.id },
                data: { lastLogoutAt: new Date() },
                select: { id: true, email: true, enrollmentNo: true },
            }).catch(() => null);

            await createStudentAuthLogSafe({
                studentId: student?.id || req.user.id,
                studentEmail: student?.email || req.user.email,
                enrollmentNo: student?.enrollmentNo || null,
                action: 'LOGOUT_SUCCESS',
                status: 'SUCCESS',
                deviceId: deviceContext.deviceId,
                deviceLabel: deviceContext.deviceLabel,
                devicePlatform: deviceContext.devicePlatform,
                ipAddress,
                userAgent: deviceContext.userAgent,
            });
        } else {
            await logAction(req, {
                action: 'LOGOUT',
                entity: 'AdminUser',
                entityId: req.user.id
            }).catch(() => { });
        }

        res.json({ success: true, data: { message: 'Logged out successfully' } });
    } catch (err) {
        next(err);
    }
});

// ── GET /me ─────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
    try {
        if (req.user.role === 'STUDENT') {
            const student = await prisma.student.findUnique({
                where: { id: req.user.id },
                select: {
                    id: true,
                    fullName: true,
                    email: true,
                    department: true,
                    studentType: true,
                    enrollmentNo: true,
                    linkedDeviceId: true,
                    linkedDeviceLabel: true,
                    linkedDevicePlatform: true,
                    deviceLinkedAt: true,
                    lastLoginAt: true,
                },
            });

            if (!student) {
                throw new AppError('Student account not found', 404, 'STUDENT_NOT_FOUND');
            }

            return res.json({
                success: true,
                data: {
                    user: mapStudentUserResponse(student),
                },
            });
        }

        const admin = await prisma.adminUser.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                department: true,
                module: true,
                gateId: true,
            },
        });

        return res.json({
            success: true,
            data: {
                user: admin || req.user,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /student/device ─────────────────────────────────────
router.get('/student/device', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'STUDENT') {
            throw new AppError('Only students can access device info', 403, 'FORBIDDEN');
        }

        const student = await prisma.student.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                fullName: true,
                enrollmentNo: true,
                email: true,
                linkedDeviceId: true,
                linkedDeviceLabel: true,
                linkedDevicePlatform: true,
                deviceLinkedAt: true,
                lastLoginAt: true,
                lastLogoutAt: true,
            },
        });

        if (!student) {
            throw new AppError('Student not found', 404, 'STUDENT_NOT_FOUND');
        }

        res.json({
            success: true,
            data: {
                student,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /student/device ───────────────────────────────────
router.patch('/student/device', authenticate, validate(updateStudentDeviceSchema), async (req, res, next) => {
    try {
        if (req.user.role !== 'STUDENT') {
            throw new AppError('Only students can update device info', 403, 'FORBIDDEN');
        }

        const student = await prisma.student.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                fullName: true,
                enrollmentNo: true,
                email: true,
                linkedDeviceId: true,
            },
        });

        if (!student) {
            throw new AppError('Student not found', 404, 'STUDENT_NOT_FOUND');
        }

        const ipAddress = resolveClientIp(req);
        const requestDeviceContext = resolveDeviceContext(req);
        const requestedDeviceId = cleanString(req.body.deviceId, 128);
        const requestedDeviceLabel = cleanString(req.body.deviceLabel, 120);
        const requestedDevicePlatform = cleanString(req.body.devicePlatform, 40);

        if (!requestedDeviceId && !requestedDeviceLabel && !requestedDevicePlatform) {
            throw new AppError('At least one device field is required', 400, 'NO_DEVICE_UPDATE_FIELDS');
        }

        if (
            requestedDeviceId
            && student.linkedDeviceId
            && requestedDeviceId !== student.linkedDeviceId
        ) {
            await createStudentAuthLogSafe({
                studentId: student.id,
                studentEmail: student.email,
                enrollmentNo: student.enrollmentNo,
                action: 'DEVICE_REBIND_DIRECT_UPDATE_BLOCKED',
                status: 'BLOCKED',
                reason: 'ADMIN_APPROVAL_REQUIRED',
                deviceId: requestedDeviceId,
                deviceLabel: requestedDeviceLabel,
                devicePlatform: requestedDevicePlatform,
                ipAddress,
                userAgent: requestDeviceContext.userAgent,
            });
            throw new AppError(
                'Device rebind requires admin approval. Please submit a rebind request.',
                409,
                'DEVICE_REBIND_ADMIN_APPROVAL_REQUIRED',
            );
        }

        if (requestedDeviceId && requestedDeviceId !== student.linkedDeviceId) {
            const conflictingStudent = await prisma.student.findFirst({
                where: {
                    linkedDeviceId: requestedDeviceId,
                    NOT: { id: student.id },
                },
                select: {
                    id: true,
                    enrollmentNo: true,
                    fullName: true,
                },
            });

            if (conflictingStudent) {
                await createStudentAuthLogSafe({
                    studentId: student.id,
                    studentEmail: student.email,
                    enrollmentNo: student.enrollmentNo,
                    action: 'DEVICE_REBIND_BLOCKED_DEVICE_LINKED_TO_OTHER_STUDENT',
                    status: 'BLOCKED',
                    reason: 'DEVICE_ALREADY_LINKED',
                    deviceId: requestedDeviceId,
                    deviceLabel: requestedDeviceLabel,
                    devicePlatform: requestedDevicePlatform,
                    linkedStudentId: conflictingStudent.id,
                    linkedEnrollmentNo: conflictingStudent.enrollmentNo,
                    ipAddress,
                    userAgent: requestDeviceContext.userAgent,
                    metadata: {
                        linkedStudentName: conflictingStudent.fullName,
                    },
                });

                throw new AppError('This device ID is already linked with another student.', 403, 'DEVICE_ALREADY_LINKED');
            }
        }

        const updateData = {};
        if (requestedDeviceId) {
            updateData.linkedDeviceId = requestedDeviceId;
            updateData.deviceLinkedAt = new Date();
        }
        if (requestedDeviceLabel) {
            updateData.linkedDeviceLabel = requestedDeviceLabel;
        }
        if (requestedDevicePlatform) {
            updateData.linkedDevicePlatform = requestedDevicePlatform;
        }

        const updatedStudent = await prisma.student.update({
            where: { id: req.user.id },
            data: updateData,
            select: {
                id: true,
                fullName: true,
                enrollmentNo: true,
                email: true,
                linkedDeviceId: true,
                linkedDeviceLabel: true,
                linkedDevicePlatform: true,
                deviceLinkedAt: true,
            },
        });

        await createStudentAuthLogSafe({
            studentId: updatedStudent.id,
            studentEmail: updatedStudent.email,
            enrollmentNo: updatedStudent.enrollmentNo,
            action: requestedDeviceId ? 'DEVICE_REBOUND' : 'DEVICE_METADATA_UPDATED',
            status: 'SUCCESS',
            deviceId: updatedStudent.linkedDeviceId,
            deviceLabel: updatedStudent.linkedDeviceLabel,
            devicePlatform: updatedStudent.linkedDevicePlatform,
            ipAddress,
            userAgent: requestDeviceContext.userAgent,
        });

        res.json({
            success: true,
            data: {
                student: updatedStudent,
                message: 'Device details updated successfully',
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /student/device/rebind-request ─────────────────────
router.post('/student/device/rebind-request', authenticate, validate(requestStudentDeviceRebindSchema), async (req, res, next) => {
    try {
        if (req.user.role !== 'STUDENT') {
            throw new AppError('Only students can request device rebind', 403, 'FORBIDDEN');
        }

        const student = await prisma.student.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                email: true,
                fullName: true,
                enrollmentNo: true,
                linkedDeviceId: true,
            },
        });

        if (!student) {
            throw new AppError('Student not found', 404, 'STUDENT_NOT_FOUND');
        }

        if (!student.linkedDeviceId) {
            throw new AppError('No existing linked device. You can update your device directly.', 400, 'DEVICE_NOT_LINKED');
        }

        const requestedDeviceId = cleanString(req.body.requestedDeviceId, 128);
        const requestedDeviceLabel = cleanString(req.body.requestedDeviceLabel, 120);
        const requestedDevicePlatform = cleanString(req.body.requestedDevicePlatform, 40);
        const reason = cleanString(req.body.reason, 240);
        const ipAddress = resolveClientIp(req);
        const requestDeviceContext = resolveDeviceContext(req);

        if (requestedDeviceId === student.linkedDeviceId) {
            throw new AppError('Requested device is already linked to your account.', 400, 'SAME_DEVICE');
        }

        const conflictingStudent = await prisma.student.findFirst({
            where: {
                linkedDeviceId: requestedDeviceId,
                NOT: { id: student.id },
            },
            select: {
                id: true,
                enrollmentNo: true,
                fullName: true,
            },
        });

        if (conflictingStudent) {
            await createStudentAuthLogSafe({
                studentId: student.id,
                studentEmail: student.email,
                enrollmentNo: student.enrollmentNo,
                action: 'DEVICE_REBIND_REQUEST_BLOCKED_DEVICE_LINKED_TO_OTHER_STUDENT',
                status: 'BLOCKED',
                reason: 'DEVICE_ALREADY_LINKED',
                deviceId: requestedDeviceId,
                deviceLabel: requestedDeviceLabel,
                devicePlatform: requestedDevicePlatform,
                linkedStudentId: conflictingStudent.id,
                linkedEnrollmentNo: conflictingStudent.enrollmentNo,
                ipAddress,
                userAgent: requestDeviceContext.userAgent,
            });

            await createStudentAlertSafe({
                studentId: student.id,
                title: 'Rebind request blocked',
                body: `Requested device is already linked to enrollment ${conflictingStudent.enrollmentNo}.`,
                ipAddress,
            });

            throw new AppError('Requested device is already linked with another student.', 403, 'DEVICE_ALREADY_LINKED');
        }

        const existingPending = await prisma.deviceRebindRequest.findFirst({
            where: {
                studentId: student.id,
                status: 'PENDING',
            },
            orderBy: { requestedAt: 'desc' },
        });

        const requestRecord = existingPending
            ? await prisma.deviceRebindRequest.update({
                where: { id: existingPending.id },
                data: {
                    currentDeviceId: student.linkedDeviceId,
                    requestedDeviceId,
                    requestedLabel: requestedDeviceLabel,
                    requestedPlatform: requestedDevicePlatform,
                    reason,
                    requestedAt: new Date(),
                    adminNote: null,
                    processedAt: null,
                    processedById: null,
                },
            })
            : await prisma.deviceRebindRequest.create({
                data: {
                    studentId: student.id,
                    currentDeviceId: student.linkedDeviceId,
                    requestedDeviceId,
                    requestedLabel: requestedDeviceLabel,
                    requestedPlatform: requestedDevicePlatform,
                    reason,
                },
            });

        await createStudentAuthLogSafe({
            studentId: student.id,
            studentEmail: student.email,
            enrollmentNo: student.enrollmentNo,
            action: 'DEVICE_REBIND_REQUESTED',
            status: 'PENDING',
            reason: reason || null,
            deviceId: requestedDeviceId,
            deviceLabel: requestedDeviceLabel,
            devicePlatform: requestedDevicePlatform,
            ipAddress,
            userAgent: requestDeviceContext.userAgent,
            metadata: {
                requestId: requestRecord.id,
                currentDeviceId: student.linkedDeviceId,
            },
        });

        await createStudentAlertSafe({
            studentId: student.id,
            title: 'Device rebind request submitted',
            body: 'Your request has been sent to admin for approval.',
            targetId: requestRecord.id,
            ipAddress,
        });

        res.status(201).json({
            success: true,
            data: {
                request: requestRecord,
                message: 'Rebind request submitted successfully',
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /student/auth-logs ──────────────────────────────────
router.get('/student/auth-logs', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'STUDENT') {
            throw new AppError('Only students can access their auth logs', 403, 'FORBIDDEN');
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const logs = await prisma.studentAuthLog.findMany({
            where: { studentId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        res.json({
            success: true,
            data: {
                logs,
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
