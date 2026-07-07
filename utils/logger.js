const path = require('path');
const fs = require('fs');
const db = require('./database');

const MAX_LOGS = 10000;
const LOG_FILE = 'logs.json';

/**
 * Normalizes input arguments dynamically to maintain 100% backward compatibility
 * with older log signatures (action, message, userId) while enabling newer,
 * metadata-rich enterprise signatures (action, message, userId, metadata).
 */
function normalizeArgs(arg1, arg2, arg3, arg4) {
    let action = arg1;
    let message = arg2;
    let userId = arg3 || null;
    let metadata = arg4 || {};

    // Handle shift when metadata is supplied as the third argument (userId is omitted)
    if (typeof arg3 === 'object' && arg3 !== null && !Array.isArray(arg3)) {
        metadata = arg3;
        userId = null;
    }

    return { action, message, userId, metadata };
}

/**
 * Parses and loads the logging database securely.
 * Auto-repairs the target file if it is corrupted or structured incorrectly.
 */
function getLogsSafely() {
    try {
        const logs = db.loadDb(LOG_FILE);
        if (Array.isArray(logs)) {
            return logs;
        }
        return [];
    } catch (err) {
        // Raw parsing recovery fallback to avoid breaking platform boot
        try {
            const rawPath = path.join(db.DB_DIR, LOG_FILE);
            if (fs.existsSync(rawPath)) {
                const content = fs.readFileSync(rawPath, 'utf8');
                const parsed = JSON.parse(content);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (rawErr) {
            console.error('[LOGGER REPAIR] Corrupted logs.json detected. Resetting logs dataset to []...', rawErr);
        }
        return [];
    }
}

/**
 * Enforces dynamic sliding window log rotation and triggers atomic saves.
 */
function writeLogsSafely(logs) {
    try {
        let rotatedLogs = logs;
        if (logs.length > MAX_LOGS) {
            rotatedLogs = logs.slice(-MAX_LOGS);
        }
        db.saveDb(LOG_FILE, rotatedLogs);
    } catch (err) {
        console.error('[LOGGER ERROR] Failed to write logs dataset atomically:', err);
    }
}

/**
 * Master logging orchestrator. Wraps filesystem updates in isolation handlers.
 */
function log(level, action, message, userId = null, metadata = {}) {
    try {
        const logs = getLogsSafely();

        const logEntry = {
            timestamp: new Date().toISOString(),
            level: (level || 'INFO').toUpperCase(),
            userId: userId ? userId.toString() : null,
            action: (action || 'GENERIC').toUpperCase(),
            message: message || '',
            metadata: (metadata && typeof metadata === 'object') ? metadata : {}
        };

        logs.push(logEntry);
        writeLogsSafely(logs);

        // Standard stdout output mirror for real-time monitoring and container-friendliness
        console.log(`[${logEntry.timestamp}] [${logEntry.level}] [${logEntry.action}] User: ${logEntry.userId || 'System'} - ${logEntry.message}`);
    } catch (err) {
        console.error('[LOGGER CRITICAL] Master log registration crashed:', err);
    }
}

// Interface Wrappers
function info(arg1, arg2, arg3, arg4) {
    const { action, message, userId, metadata } = normalizeArgs(arg1, arg2, arg3, arg4);
    log('INFO', action, message, userId, metadata);
}

function warn(arg1, arg2, arg3, arg4) {
    const { action, message, userId, metadata } = normalizeArgs(arg1, arg2, arg3, arg4);
    log('WARN', action, message, userId, metadata);
}

function error(arg1, arg2, arg3, arg4) {
    const { action, message, userId, metadata } = normalizeArgs(arg1, arg2, arg3, arg4);
    log('ERROR', action, message, userId, metadata);
}

// Backward compatibility helper mapping to ADMIN_ACTION level
function admin(arg1, arg2, arg3, arg4) {
    const { action, message, userId, metadata } = normalizeArgs(arg1, arg2, arg3, arg4);
    log('ADMIN_ACTION', action, message, userId, metadata);
}

module.exports = {
    log,
    info,
    warn,
    error,
    admin
};
