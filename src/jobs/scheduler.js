// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Scheduled Jobs (node-cron)
// ═══════════════════════════════════════════════════════════════

const cron = require('node-cron');
const logger = require('../config/logger');
const { scheduleOverdueReminders, scheduleAttendanceAlerts, scheduleHostellerCurfewAlerts } = require('../services/notification.service');
const { sendDailyEventReports } = require('../services/eventReports.service');

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

// Daily at 8:00 PM IST — event stay/mess CSV report emails
cron.schedule('0 20 * * *', async () => {
    logger.info('[CRON] Running event daily report emails...');
    try {
        const outcomes = await sendDailyEventReports(new Date());
        logger.info('[CRON] Event report email outcomes', { total: outcomes.length, outcomes });
    } catch (err) {
        logger.error('[CRON] Event daily report emails failed:', err);
    }
// Every 2 minutes — check for offline RFID readers
cron.schedule('*/2 * * * *', async () => {
    try {
        const { markOfflineReaders } = require('../services/rfidReader.service');
        const offlineIds = await markOfflineReaders();
        if (offlineIds.length > 0) {
            const { emitReaderStatusChange } = require('../sockets/rfidFeed.socket');
            offlineIds.forEach((readerId) => {
                emitReaderStatusChange({ readerId, isOnline: false, status: 'OFFLINE' });
            });
        }
    } catch (err) {
        logger.error('[CRON] Offline reader check failed:', err);
    }
});

logger.info('⏰ Scheduled jobs registered');
