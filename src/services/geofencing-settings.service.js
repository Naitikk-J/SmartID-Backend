const config = require('../config/env');

function toFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

const rawQrTtl = Number(config.ACCESS_QR_TTL_SECONDS);

const state = {
    campusCenterLat: toFiniteNumber(process.env.CAMPUS_LAT, 26.2183),
    campusCenterLng: toFiniteNumber(process.env.CAMPUS_LNG, 78.1828),
    campusRadiusMetres: clamp(toFiniteNumber(process.env.CAMPUS_RADIUS_METRES, 500), 100, 5000),
    attendanceRadiusMetres: clamp(toFiniteNumber(process.env.ATTENDANCE_RADIUS_METRES, 200), 20, 2000),
    eventScanRadiusMetres: clamp(
        toFiniteNumber(process.env.EVENT_SCAN_RADIUS_METRES, toFiniteNumber(process.env.CAMPUS_RADIUS_METRES, 500)),
        100,
        5000,
    ),
    accessQrTtlSeconds: Number.isFinite(rawQrTtl)
        ? clamp(Math.round(rawQrTtl), 15, 120)
        : 30,
    accessRequireGeofence: toBoolean(config.ACCESS_REQUIRE_GEOFENCE, false),
    updatedAt: null,
};

function getGeofencingSettings() {
    return { ...state };
}

function updateGeofencingSettings(patch = {}) {
    if (patch.campusCenterLat !== undefined) {
        state.campusCenterLat = clamp(Number(patch.campusCenterLat), -90, 90);
    }

    if (patch.campusCenterLng !== undefined) {
        state.campusCenterLng = clamp(Number(patch.campusCenterLng), -180, 180);
    }

    if (patch.campusRadiusMetres !== undefined) {
        state.campusRadiusMetres = clamp(Number(patch.campusRadiusMetres), 100, 5000);
    }

    if (patch.attendanceRadiusMetres !== undefined) {
        state.attendanceRadiusMetres = clamp(Number(patch.attendanceRadiusMetres), 20, 2000);
    }

    if (patch.eventScanRadiusMetres !== undefined) {
        state.eventScanRadiusMetres = clamp(Number(patch.eventScanRadiusMetres), 100, 5000);
    }

    if (patch.accessQrTtlSeconds !== undefined) {
        state.accessQrTtlSeconds = clamp(Math.round(Number(patch.accessQrTtlSeconds)), 15, 120);
    }

    if (patch.accessRequireGeofence !== undefined) {
        state.accessRequireGeofence = Boolean(patch.accessRequireGeofence);
    }

    state.updatedAt = new Date().toISOString();
    return getGeofencingSettings();
}

module.exports = {
    getGeofencingSettings,
    updateGeofencingSettings,
};
