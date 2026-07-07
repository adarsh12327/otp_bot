const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'database');

// Default schemas for platform databases
const defaultFiles = {
    'users.json': {},
    'wallet.json': {},
    'products.json': [
        { id: 'prod_tg', name: 'Telegram', emoji: '💬', price: 15.00, description: 'Virtual lines for Telegram.', category: 'Socials', status: 'active', order: 1 },
        { id: 'prod_wa', name: 'WhatsApp', emoji: '🟢', price: 25.00, description: 'Bypass OTP verification for WA.', category: 'Socials', status: 'active', order: 2 },
        { id: 'prod_go', name: 'Google', emoji: '📧', price: 10.00, description: 'Google and Gmail bypass channels.', category: 'Tech Suite', status: 'active', order: 3 }
    ],
    'orders.json': [],
    'transactions.json': [],
    'referrals.json': {},
    'flaggedReferrals.json': [],
    'logs.json': [],
    'settings.json': {
        bot_name: 'Enterprise SMS Platform',
        currency: '₹',
        referral_percent: 10,
        support_username: 'EnterpriseSupportBot',
        maintenance_mode: false,
        min_recharge: 100,
        max_recharge: 50000,
        order_timeout: 120,
        theme: 'Dark Premium',
        admins: []
    },
    'providers.json': [
        { id: 'prov_primary', name: 'Simulated Provider A', url: 'http://localhost:3000/api', key: 'mock_key_alpha', priority: 1, status: 'active' },
        { id: 'prov_secondary', name: 'Simulated Provider B (Failover)', url: 'http://localhost:3000/api', key: 'mock_key_beta', priority: 2, status: 'active' }
    ]
};

/**
 * Clean path-traversal prevention helper.
 * Restricts access to flat filenames within DB_DIR.
 */
function getSafePath(filename) {
    const safeFilename = path.basename(filename);
    return path.join(DB_DIR, safeFilename);
}

/**
 * Standard database engine error logger fallback.
 * Prevents throwing errors to the main execution context.
 */
function logDbError(msg, err) {
    console.error(`[DATABASE WARNING] ${msg}`, err || '');
}

/**
 * Re-creates the core database directory if missing.
 * Initializes default files safely.
 */
function ensureDb() {
    try {
        if (!fs.existsSync(DB_DIR)) {
            fs.mkdirSync(DB_DIR, { recursive: true });
        }

        Object.keys(defaultFiles).forEach(file => {
            const filePath = getSafePath(file);
            if (!fs.existsSync(filePath)) {
                const fallback = defaultFiles[file];
                // Atomic save default on check
                const tempPath = `${filePath}.tmp`;
                fs.writeFileSync(tempPath, JSON.stringify(fallback, null, 4), 'utf8');
                fs.renameSync(tempPath, filePath);
            }
        });
        return true;
    } catch (err) {
        logDbError('Verification check failed for directory structure:', err);
        return false;
    }
}

/**
 * Backs up a database file to a .bak duplicate safely.
 */
function backupDb(filename) {
    try {
        const srcPath = getSafePath(filename);
        const destPath = `${srcPath}.bak`;

        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
            return true;
        }
        return false;
    } catch (err) {
        logDbError(`Failed to back up dataset for ${filename}:`, err);
        return false;
    }
}

/**
 * Restores a database file from its .bak duplicate.
 */
function restoreDb(filename) {
    try {
        const safeFilename = path.basename(filename);
        const srcPath = `${getSafePath(safeFilename)}.bak`;
        const destPath = getSafePath(safeFilename);

        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
            return true;
        }
        return false;
    } catch (err) {
        logDbError(`Failed to restore dataset from backup for ${filename}:`, err);
        return false;
    }
}

/**
 * Reads and parses database entries safely.
 * Includes automated hot-patching of missing or corrupted files.
 */
function loadDb(filename) {
    const safeFilename = path.basename(filename);
    const filePath = getSafePath(safeFilename);
    const fallbackDefault = defaultFiles[safeFilename] || {};

    try {
        // Recover if file is missing
        if (!fs.existsSync(filePath)) {
            logDbError(`Dataset missing for ${safeFilename}. Attempting recovery...`);
            const restored = restoreDb(safeFilename);
            if (!restored) {
                saveDb(safeFilename, fallbackDefault);
                return fallbackDefault;
            }
        }

        const rawContent = fs.readFileSync(filePath, 'utf8');
        try {
            return JSON.parse(rawContent);
        } catch (parseErr) {
            logDbError(`Corrupted JSON structure found in ${safeFilename}. Retrying with backup...`, parseErr);
            const restored = restoreDb(safeFilename);
            if (restored) {
                const recoveredContent = fs.readFileSync(filePath, 'utf8');
                try {
                    return JSON.parse(recoveredContent);
                } catch (secParseErr) {
                    logDbError(`Backup dataset for ${safeFilename} is also corrupted. Resetting to defaults.`, secParseErr);
                }
            }
            saveDb(safeFilename, fallbackDefault);
            return fallbackDefault;
        }
    } catch (err) {
        logDbError(`Critical read exception on ${safeFilename}. Accessing memory safe fallbacks.`, err);
        return fallbackDefault;
    }
}

/**
 * Writes data atomic and safe.
 * Rejects undefined payloads.
 */
function saveDb(filename, data) {
    if (data === undefined) {
        logDbError(`Write rejected: payload dataset for ${filename} was undefined.`);
        return false;
    }

    try {
        const safeFilename = path.basename(filename);
        const filePath = getSafePath(safeFilename);
        const tempPath = `${filePath}.tmp`;

        // Create backup of current state
        backupDb(safeFilename);

        // Atomic write via temp file
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 4), 'utf8');
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (err) {
        logDbError(`Critical write exception during atomic save for ${filename}:`, err);
        return false;
    }
}

// Auto-run directory/schema validation on file import
ensureDb();

module.exports = {
    loadDb,
    saveDb,
    DB_DIR,
    ensureDb,
    backupDb,
    restoreDb
};
