const fs = require('fs');
const path = require('path');

// Safe, non-crashing loading of dotenv variables
try {
    require('dotenv').config();
} catch (err) {
    console.warn('⚠️  [CONFIG WARNING] Failed to load dotenv. Environmental loading skipped.', err);
}

// Friendly warnings if the ".env" file is missing entirely
if (!fs.existsSync(path.join(__dirname, '.env'))) {
    console.warn('⚠️  [CONFIG WARNING] No ".env" file detected in root workspace. Falling back to default system values.');
}

// Parse ADMIN_IDS into a clean, duplicate-free array of parsed integers
const rawAdminIds = process.env.ADMIN_IDS || '0';
const adminIdsArray = [...new Set(
    rawAdminIds.split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id))
)];

/**
 * Validate and safely parse numeric variables to prevent runtime NaN pollution.
 */
const parseNumeric = (value, fallback) => {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
};

const config = {
    // Required Core Bot Variables
    BOT_TOKEN: process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN',
    ADMIN_IDS: adminIdsArray,
    ADMIN_ID: adminIdsArray[0] || 0, // Legacy support mapping (Main Administrator)
    PORT: Math.floor(parseNumeric(process.env.PORT, 3000)),
    API_URL: process.env.API_URL || 'http://localhost:3000/api',
    LOCAL_API_URL: process.env.API_URL || 'http://localhost:3000/api', // Legacy backward compatibility mapping
    API_KEY: process.env.API_KEY || 'mock_key_alpha',

    // Global Platform Settings Configuration
    currency: process.env.CURRENCY || '₹',
    bot_name: process.env.BOT_NAME || 'Enterprise SMS Platform',
    support_username: process.env.SUPPORT_USERNAME || 'EnterpriseSupportBot',
    referral_percent: parseNumeric(process.env.REFERRAL_PERCENT, 10),
    order_timeout: Math.floor(parseNumeric(process.env.ORDER_TIMEOUT, 120)),
    min_recharge: parseNumeric(process.env.MIN_RECHARGE, 100),
    max_recharge: parseNumeric(process.env.MAX_RECHARGE, 50000),
    maintenance_mode: process.env.MAINTENANCE_MODE === 'true',

    /**
     * Verifies if a user has administrative roles inside the platform.
     */
    isAdmin(userId) {
        if (!userId) return false;
        const targetId = parseInt(userId, 10);
        return this.ADMIN_IDS.includes(targetId);
    },

    /**
     * Dynamic state helper for Maintenance Mode.
     * Checks database setting updates at runtime before falling back to system configs.
     */
    isMaintenance() {
        try {
            const settingsPath = path.join(__dirname, 'database', 'settings.json');
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings && typeof settings.maintenance_mode === 'boolean') {
                    return settings.maintenance_mode;
                }
            }
        } catch (err) {
            // Dynamic check fallback to static config environment properties
        }
        return this.maintenance_mode;
    }
};

// Console warnings on key parameters configured with default values
if (config.BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
    console.warn('⚠️  [CONFIG WARNING] "BOT_TOKEN" is unconfigured. The bot application will fail to start.');
}
if (config.ADMIN_ID === 0) {
    console.warn('⚠️  [CONFIG WARNING] No valid "ADMIN_IDS" loaded. SaaS administration panels will be inaccessible.');
}

module.exports = config;
