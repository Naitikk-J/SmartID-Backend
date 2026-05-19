const fs = require('fs');
const path = require('path');
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

// Default initial state from ENV
const initialState = {
    campusCenterLat: toFiniteNumber(process.env.CAMPUS_LAT, 26.2183),
    campusCenterLng: toFiniteNumber(process.env.CAMPUS_LNG, 78.1828),
    campusRadiusMetres: clamp(toFiniteNumber(process.env.CAMPUS_RADIUS_METRES, 500), 100, 50000),
    attendanceRadiusMetres: clamp(toFiniteNumber(process.env.ATTENDANCE_RADIUS_METRES, 200), 20, 50000),
    eventScanRadiusMetres: clamp(
        toFiniteNumber(process.env.EVENT_SCAN_RADIUS_METRES, toFiniteNumber(process.env.CAMPUS_RADIUS_METRES, 500)),
        100,
        50000,
    ),
    accessQrTtlSeconds: Number.isFinite(rawQrTtl)
        ? clamp(Math.round(rawQrTtl), 15, 120)
        : 30,
    accessRequireGeofence: toBoolean(config.ACCESS_REQUIRE_GEOFENCE, false),
    updatedAt: null,
};

const SETTINGS_FILE = path.join(__dirname, '../../data/geofencing.json');

let state = { ...initialState };

function loadState() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const savedState = JSON.parse(data);
            state = { ...state, ...savedState };
        }
    } catch (e) {
        console.error('Failed to load geofencing settings:', e);
    }
}

function saveState() {
    try {
        if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
            fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save geofencing settings:', e);
    }
}

// Load initial state on startup
loadState();

function getGeofencingSettings() {
    return { ...state };
}

// Lazy require so tests that don't need cache can run standalone.
let cache;
function getCache() {
    if (cache) return cache;
    try { cache = require('./cache.service'); } catch { cache = null; }
    return cache;
}

function updateGeofencingSettings(patch = {}) {
    if (patch.campusCenterLat !== undefined) {
        state.campusCenterLat = clamp(Number(patch.campusCenterLat), -90, 90);
    }

    if (patch.campusCenterLng !== undefined) {
        state.campusCenterLng = clamp(Number(patch.campusCenterLng), -180, 180);
    }

    if (patch.campusRadiusMetres !== undefined) {
        state.campusRadiusMetres = clamp(Number(patch.campusRadiusMetres), 100, 50000);
    }

    if (patch.attendanceRadiusMetres !== undefined) {
        state.attendanceRadiusMetres = clamp(Number(patch.attendanceRadiusMetres), 20, 50000);
    }

    if (patch.eventScanRadiusMetres !== undefined) {
        state.eventScanRadiusMetres = clamp(Number(patch.eventScanRadiusMetres), 100, 50000);
    }

    if (patch.accessQrTtlSeconds !== undefined) {
        state.accessQrTtlSeconds = clamp(Math.round(Number(patch.accessQrTtlSeconds)), 15, 120);
    }

    if (patch.accessRequireGeofence !== undefined) {
        state.accessRequireGeofence = Boolean(patch.accessRequireGeofence);
    }

    state.updatedAt = new Date().toISOString();
    
    // Persist changes
    saveState();

    // Bust any downstream cache that depends on geofencing geometry.
    const c = getCache();
    if (c) {
        c.invalidatePrefix('exit:activeEvent:').catch(() => { /* best-effort */ });
    }

    return getGeofencingSettings();
}

module.exports = {
    getGeofencingSettings,
    updateGeofencingSettings,
};
