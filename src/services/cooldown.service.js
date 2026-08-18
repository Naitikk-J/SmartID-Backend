// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Re-entry Cooldown & Anti-Passback Engine
// Controls directional flow, minimum stay duration, re-entry cooldowns,
// and anti-passback (APB) policies for both RFID and QR gates.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const prisma = require('../config/database');
const logger = require('../config/logger');

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

const SETTINGS_FILE = path.join(__dirname, '../../data/cooldown-settings.json');

// Default initial cooldown settings
const initialSettings = {
    reentryCooldownSeconds: clamp(toFiniteNumber(process.env.REENTRY_COOLDOWN_SECONDS, 120), 0, 7200), // 2 min default
    stayCooldownSeconds: clamp(toFiniteNumber(process.env.STAY_COOLDOWN_SECONDS, 60), 0, 3600),       // 1 min minimum stay
    tapDebounceSeconds: clamp(toFiniteNumber(process.env.TAP_DEBOUNCE_SECONDS, 5), 1, 60),            // 5 sec debounce
    antiPassbackMode: process.env.ANTI_PASSBACK_MODE || 'TIMED',                                      // 'TIMED' | 'STRICT' | 'DISABLED'
    dayScholarExempt: toBoolean(process.env.DAY_SCHOLAR_COOLDOWN_EXEMPT, true),
    allowEmergencyOverride: true,
    updatedAt: new Date().toISOString(),
};

let settingsState = { ...initialSettings };

// In-memory active emergency overrides (studentId -> expiresAt)
const temporaryOverrides = new Map();

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const saved = JSON.parse(data);
            settingsState = { ...settingsState, ...saved };
        }
    } catch (e) {
        logger.error('Failed to load cooldown settings:', e);
    }
}

function saveSettings() {
    try {
        if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
            fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsState, null, 2), 'utf8');
    } catch (e) {
        logger.error('Failed to save cooldown settings:', e);
    }
}

loadSettings();

/**
 * Get current cooldown settings.
 */
function getCooldownSettings() {
    return { ...settingsState };
}

/**
 * Update cooldown settings (Admin endpoint).
 */
function updateCooldownSettings(patch = {}) {
    if (patch.reentryCooldownSeconds !== undefined) {
        settingsState.reentryCooldownSeconds = clamp(Math.round(Number(patch.reentryCooldownSeconds)), 0, 7200);
    }
    if (patch.stayCooldownSeconds !== undefined) {
        settingsState.stayCooldownSeconds = clamp(Math.round(Number(patch.stayCooldownSeconds)), 0, 3600);
    }
    if (patch.tapDebounceSeconds !== undefined) {
        settingsState.tapDebounceSeconds = clamp(Math.round(Number(patch.tapDebounceSeconds)), 1, 60);
    }
    if (patch.antiPassbackMode !== undefined) {
        const mode = String(patch.antiPassbackMode).toUpperCase();
        if (['TIMED', 'STRICT', 'DISABLED'].includes(mode)) {
            settingsState.antiPassbackMode = mode;
        }
    }
    if (patch.dayScholarExempt !== undefined) {
        settingsState.dayScholarExempt = Boolean(patch.dayScholarExempt);
    }
    if (patch.allowEmergencyOverride !== undefined) {
        settingsState.allowEmergencyOverride = Boolean(patch.allowEmergencyOverride);
    }

    settingsState.updatedAt = new Date().toISOString();
    saveSettings();

    logger.info('Re-entry cooldown settings updated', settingsState);
    return getCooldownSettings();
}

/**
 * Grant a 15-minute temporary cooldown override for a student (e.g., security guard override).
 */
function grantTemporaryOverride(studentId, adminId, reason = 'Security Override') {
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins
    temporaryOverrides.set(studentId, { expiresAt, adminId, reason });
    logger.info('Temporary cooldown override granted', { studentId, adminId, reason });
    return { studentId, expiresAt: new Date(expiresAt) };
}

/**
 * Check if a student has an active emergency override.
 */
function hasActiveOverride(studentId) {
    const item = temporaryOverrides.get(studentId);
    if (!item) return false;
    if (Date.now() > item.expiresAt) {
        temporaryOverrides.delete(studentId);
        return false;
    }
    return true;
}

/**
 * Core Evaluation Engine:
 * Validates whether a student can pass through (ENTRY or EXIT) based on:
 *   1. Rapid tap debounce
 *   2. Re-entry cooldown (EXIT -> ENTRY timing)
 *   3. Stay cooldown (ENTRY -> EXIT timing)
 *   4. Directional Anti-Passback (Strict vs Timed)
 *
 * @param {Object} params
 * @param {Object} params.student - Student record
 * @param {string} params.direction - 'ENTRY' | 'EXIT'
 * @param {string} [params.gateId] - Gate identifier
 * @param {Date} [params.currentTime] - Timestamp of tap
 * @param {boolean} [params.forceOverride] - Explicit operator override
 */
async function evaluateReentryCooldown({
    student,
    direction = 'ENTRY',
    gateId = null,
    currentTime = new Date(),
    forceOverride = false,
}) {
    const settings = getCooldownSettings();
    const studentId = student.id;
    const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
    const nowMs = now.getTime();

    // 0. Emergency / Manual Override Check
    if (forceOverride || (settings.allowEmergencyOverride && hasActiveOverride(studentId))) {
        return {
            allowed: true,
            isOverridden: true,
            reason: 'OVERRIDE_APPLIED',
            message: 'Emergency / Operator cooldown override applied',
            cooldownSecondsRemaining: 0,
            cooldownWindowSeconds: 0,
        };
    }

    // 1. Day Scholar Exemption (if enabled)
    if (settings.dayScholarExempt && student.studentType === 'DAY_SCHOLAR') {
        // Still apply a basic 5s hardware debounce
        const lastDebounceEvent = await prisma.exitEvent.findFirst({
            where: { studentId },
            orderBy: { eventTime: 'desc' },
            select: { eventTime: true, direction: true },
        });

        if (lastDebounceEvent) {
            const elapsedSeconds = (nowMs - new Date(lastDebounceEvent.eventTime).getTime()) / 1000;
            if (elapsedSeconds < settings.tapDebounceSeconds && lastDebounceEvent.direction === direction) {
                return {
                    allowed: false,
                    reason: 'DUPLICATE_TAP',
                    message: `Duplicate ${direction.toLowerCase()} tap detected. Please wait ${Math.ceil(settings.tapDebounceSeconds - elapsedSeconds)}s.`,
                    cooldownSecondsRemaining: Math.ceil(settings.tapDebounceSeconds - elapsedSeconds),
                    cooldownWindowSeconds: settings.tapDebounceSeconds,
                };
            }
        }

        return {
            allowed: true,
            isExempt: true,
            reason: 'DAY_SCHOLAR_EXEMPT',
            message: 'Day scholar open access',
            cooldownSecondsRemaining: 0,
            cooldownWindowSeconds: 0,
        };
    }

    // 2. Fetch the student's most recent directional event today
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const lastEvent = await prisma.exitEvent.findFirst({
        where: {
            studentId,
            eventTime: { gte: todayStart },
        },
        orderBy: { eventTime: 'desc' },
    });

    // If no prior events today, entry or exit is allowed
    if (!lastEvent) {
        return {
            allowed: true,
            reason: 'FIRST_EVENT_TODAY',
            message: `First ${direction.toLowerCase()} approved`,
            cooldownSecondsRemaining: 0,
            cooldownWindowSeconds: 0,
            previousDirection: null,
        };
    }

    const lastTimeMs = new Date(lastEvent.eventTime).getTime();
    const elapsedSeconds = Math.max(0, (nowMs - lastTimeMs) / 1000);
    const lastDirection = lastEvent.direction; // 'ENTRY' or 'EXIT'

    // 3. Rapid Tap Debounce (same direction within tapDebounceSeconds)
    if (elapsedSeconds < settings.tapDebounceSeconds && lastDirection === direction) {
        const remaining = Math.ceil(settings.tapDebounceSeconds - elapsedSeconds);
        return {
            allowed: false,
            reason: 'DUPLICATE_TAP',
            message: `Duplicate tap. Please wait ${remaining}s.`,
            cooldownSecondsRemaining: remaining,
            cooldownWindowSeconds: settings.tapDebounceSeconds,
            previousDirection: lastDirection,
        };
    }

    // 4. Directional Anti-Passback & Re-entry Cooldowns
    if (settings.antiPassbackMode !== 'DISABLED') {

        // ─── Case A: Requesting ENTRY ───
        if (direction === 'ENTRY') {
            // A1. Already inside campus/hostel (Last was ENTRY)
            if (lastDirection === 'ENTRY') {
                if (settings.antiPassbackMode === 'STRICT') {
                    return {
                        allowed: false,
                        reason: 'ALREADY_ENTERED',
                        message: 'Anti-Passback Violation: Student has already entered. An EXIT record is required before re-entering.',
                        cooldownSecondsRemaining: 0,
                        cooldownWindowSeconds: settings.reentryCooldownSeconds,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }

                // In TIMED mode: Check if rapid duplicate entry
                if (elapsedSeconds < settings.stayCooldownSeconds) {
                    const remaining = Math.ceil(settings.stayCooldownSeconds - elapsedSeconds);
                    return {
                        allowed: false,
                        reason: 'ALREADY_ENTERED',
                        message: `Student already marked inside campus. Cooldown active for ${remaining}s.`,
                        cooldownSecondsRemaining: remaining,
                        cooldownWindowSeconds: settings.stayCooldownSeconds,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }
            }

            // A2. Student previously EXITED -> Check RE-ENTRY COOLDOWN
            if (lastDirection === 'EXIT') {
                const cooldownWindow = settings.reentryCooldownSeconds;
                if (elapsedSeconds < cooldownWindow) {
                    const remaining = Math.ceil(cooldownWindow - elapsedSeconds);
                    return {
                        allowed: false,
                        reason: 'REENTRY_COOLDOWN_ACTIVE',
                        message: `Re-entry cooldown active. Must wait ${remaining}s after exiting before re-entering.`,
                        cooldownSecondsRemaining: remaining,
                        cooldownWindowSeconds: cooldownWindow,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }
            }
        }

        // ─── Case B: Requesting EXIT ───
        if (direction === 'EXIT') {
            // B1. Already outside campus/hostel (Last was EXIT)
            if (lastDirection === 'EXIT') {
                if (settings.antiPassbackMode === 'STRICT') {
                    return {
                        allowed: false,
                        reason: 'ALREADY_EXITED',
                        message: 'Anti-Passback Violation: Student has already exited. An ENTRY record is required before exiting again.',
                        cooldownSecondsRemaining: 0,
                        cooldownWindowSeconds: settings.stayCooldownSeconds,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }

                // In TIMED mode: Check if rapid duplicate exit
                if (elapsedSeconds < settings.reentryCooldownSeconds) {
                    const remaining = Math.ceil(settings.reentryCooldownSeconds - elapsedSeconds);
                    return {
                        allowed: false,
                        reason: 'ALREADY_EXITED',
                        message: `Student already marked outside campus. Cooldown active for ${remaining}s.`,
                        cooldownSecondsRemaining: remaining,
                        cooldownWindowSeconds: settings.reentryCooldownSeconds,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }
            }

            // B2. Student previously ENTERED -> Check MINIMUM STAY COOLDOWN
            if (lastDirection === 'ENTRY') {
                const stayWindow = settings.stayCooldownSeconds;
                if (elapsedSeconds < stayWindow) {
                    const remaining = Math.ceil(stayWindow - elapsedSeconds);
                    return {
                        allowed: false,
                        reason: 'STAY_COOLDOWN_ACTIVE',
                        message: `Minimum campus stay duration active. Please wait ${remaining}s before exiting.`,
                        cooldownSecondsRemaining: remaining,
                        cooldownWindowSeconds: stayWindow,
                        previousDirection: lastDirection,
                        lastEventTime: lastEvent.eventTime,
                    };
                }
            }
        }
    }

    // 5. All cooldown and anti-passback checks passed
    return {
        allowed: true,
        reason: 'COOLDOWN_PASSED',
        message: `${direction} approved`,
        cooldownSecondsRemaining: 0,
        cooldownWindowSeconds: direction === 'ENTRY' ? settings.reentryCooldownSeconds : settings.stayCooldownSeconds,
        previousDirection: lastDirection,
        lastEventTime: lastEvent.eventTime,
        elapsedSecondsSinceLast: Math.round(elapsedSeconds),
    };
}

module.exports = {
    getCooldownSettings,
    updateCooldownSettings,
    grantTemporaryOverride,
    hasActiveOverride,
    evaluateReentryCooldown,
};
