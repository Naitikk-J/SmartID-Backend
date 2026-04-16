// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Scheduled Jobs (node-cron)
// ═══════════════════════════════════════════════════════════════

const cron = require('node-cron');
const logger = require('../config/logger');
const { scheduleOverdueReminders, scheduleAttendanceAlerts, scheduleHostellerCurfewAlerts } = require('../services/notification.service');

// Daily at 8:00 AM — overdue library reminders
cron.schedule('0 8 * * *', async () => {
    logger.info('[CRON] Running overdue library reminders...');
    try {
        await scheduleOverdueReminders();
    } catch (err) {
        logger.error('[CRON] Overdue reminders failed:', err);
    }
});

// Daily at 6:00 PM — low attendance alerts
cron.schedule('0 18 * * *', async () => {
    logger.info('[CRON] Running attendance alerts...');
    try {
        await scheduleAttendanceAlerts();
    } catch (err) {
        logger.error('[CRON] Attendance alerts failed:', err);
    }
});

// Every 5 minutes — hosteller curfew reminder + crossed warnings.
cron.schedule('*/5 * * * *', async () => {
    logger.info('[CRON] Running hosteller curfew alerts...');
    try {
        await scheduleHostellerCurfewAlerts();
    } catch (err) {
        logger.error('[CRON] Curfew alerts failed:', err);
    }
});

logger.info('⏰ Scheduled jobs registered');
