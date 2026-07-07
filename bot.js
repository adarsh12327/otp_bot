const {Telegraf, session } = require('telegraf');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const server = require('./server');
const db = require('./utils/database');
const security = require('./utils/security');
const logger = require('./utils/logger');

// Outbound API and failover managers
const providerService = require('./services/providerService');

// Platform Handler modules
const userHandler = require('./handlers/user');
const adminHandler = require('./handlers/admin');
const walletHandler = require('./handlers/wallet');
const referralHandler = require('./handlers/referral');
const orderHandler = require('./handlers/order');
const { showLoading } = require('./handlers/order');
// ==========================================
// STARTUP PROTECTION & DUPLICATE LAUNCH LOCK
// ==========================================
const lockFile = path.join(db.DB_DIR, 'bot.lock');

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

try {
    if (fs.existsSync(lockFile)) {
        const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        if (oldPid && isProcessRunning(oldPid)) {
            console.error(`⚠️  [STARTUP ERROR] Duplicate instance execution detected (PID: ${oldPid}). Exiting process to protect polling webhook lines.`);
            process.exit(1);
        }
    }
    fs.writeFileSync(lockFile, process.pid.toString(), 'utf8');
} catch (err) {
    console.error('⚠️  [STARTUP ERROR] Lock validation failed:', err.message);
}

// ==========================================
// GLOBAL EXCEPTION BOUNDARIES
// ==========================================
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT_EXCEPTION', `Uncaught exception error boundary: ${err.message}`, null, { stack: err.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED_REJECTION', `Unhandled promise rejection boundary: ${reason}`, null, { trace: String(reason) });
});

// ==========================================
// COMPATIBILITY LAYER FOR ADMIN MENU
// ==========================================
function safeAdminMenu(ctx) {
    if (typeof adminHandler.renderAdminDashboard === 'function') {
        return adminHandler.renderAdminDashboard(ctx);
    }

    if (typeof adminHandler.renderAdminMenu === 'function') {
        return adminHandler.renderAdminMenu(ctx);
    }

return ctx.reply('❌ Admin panel unavailable.');
}

// ==========================================
// DATABASE FILE BOOTSTRAPPING & SANITIZATION
// ==========================================
function initializeDatabases() {
    if (!fs.existsSync(db.DB_DIR)) {
        fs.mkdirSync(db.DB_DIR, { recursive: true });
    }

    const files = {
        'users.json': '{}',
        'wallet.json': '{}',
        'orders.json': '[]',
        'settings.json': JSON.stringify({
            "bot_name": "Adarshpatel",
            "currency": "₹",
            "referral_percent": 10,
            "support_username": "kaplooter",
            "maintenance_mode": false,
            "min_recharge": 20,
            "max_recharge": 50000,
            "order_timeout": 300,
            "theme": "Dark Premium",
            "admins": [],
            "pending_payments": [],
            "pending_withdrawals": []
        }, null, 2),
        'logs.json': '[]',
        'referrals.json': '{}',
        'flaggedReferrals.json': '[]',
        'providers.json': '[]',
        'services.json': '[]',
        'countries.json': '[]'
    };

    for (const [file, defaultVal] of Object.entries(files)) {
        const pth = path.join(db.DB_DIR, file);
        if (!fs.existsSync(pth) || fs.readFileSync(pth, 'utf8').trim() === '') {
            fs.writeFileSync(pth, defaultVal, 'utf8');
        }
    }
}

function validateCategoriesFile(dbDirectory) {
    const categoriesPath = path.join(dbDirectory, 'categories.json');
    const defaultCategories = ["Social", "Email", "Gaming", "Shopping", "Finance", "Others", "Telegram", "WhatsApp"];
    let categories = [];
    let rewriteNeeded = false;

    if (!fs.existsSync(categoriesPath)) {
        categories = defaultCategories;
        rewriteNeeded = true;
    } else {
        try {
            const rawData = fs.readFileSync(categoriesPath, 'utf8').trim();
            if (!rawData) {
                categories = defaultCategories;
                rewriteNeeded = true;
            } else {
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    categories = parsed
                        .map(item => {
                            if (typeof item === 'object' && item !== null) {
                                return (item.name || item.code || '').trim();
                            }
                            return typeof item === 'string' ? item.trim() : String(item).trim();
                        })
                        .filter(item => item !== '');
                    const originalLength = categories.length;
                    categories = Array.from(new Set(categories));
                    if (categories.length !== originalLength || categories.length === 0) {
                        rewriteNeeded = true;
                    }
                } else {
                    categories = defaultCategories;
                    rewriteNeeded = true;
                }
            }
        } catch (err) {
            categories = defaultCategories;
            rewriteNeeded = true;
        }
    }

    if (categories.length === 0) {
        categories = defaultCategories;
        rewriteNeeded = true;
    }

    if (rewriteNeeded) {
        try {
            fs.writeFileSync(categoriesPath, JSON.stringify(categories, null, 2), 'utf8');
        } catch (err) {
            console.error('⚠️ Failed to write validated categories.json:', err.message);
        }
    }
}

function validateProductsFile(dbDirectory) {
    const productsPath = path.join(dbDirectory, 'products.json');
    let products = [];
    let rewriteNeeded = false;

    if (!fs.existsSync(productsPath)) {
        try {
            fs.writeFileSync(productsPath, JSON.stringify([], null, 2), 'utf8');
        } catch (err) {
            console.error('⚠️ Failed to create empty products.json:', err.message);
        }
        return;
    }

    try {
        const rawData = fs.readFileSync(productsPath, 'utf8').trim();
        if (!rawData) {
            products = [];
            rewriteNeeded = true;
        } else {
            products = JSON.parse(rawData);
            if (!Array.isArray(products)) {
                products = [];
                rewriteNeeded = true;
            }
        }
    } catch (err) {
        try {
            fs.renameSync(productsPath, `${productsPath}.corrupt_${Date.now()}`);
            fs.writeFileSync(productsPath, JSON.stringify([], null, 2), 'utf8');
        } catch (e) {}
        return;
    }

    const usedIds = new Set();
    const validatedProducts = [];

    for (let p of products) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
            rewriteNeeded = true;
            continue;
        }

        if (!p.name || typeof p.name !== 'string' || p.name.trim() === '' ||
            !p.code || typeof p.code !== 'string' || p.code.trim() === '') {
            rewriteNeeded = true;
            continue;
        }

        let id = p.id;
        if (!id || typeof id !== 'string' || id.trim() === '' || usedIds.has(id)) {
            id = 'prod_' + Math.random().toString(36).substring(2, 9);
            rewriteNeeded = true;
        }
        usedIds.add(id);

        const category = typeof p.category === 'string' && p.category.trim() !== '' ? p.category.trim() : 'Others';
        const country = typeof p.country === 'string' && p.country.trim() !== '' ? p.country.trim() : 'India';

        let countryCode = parseInt(p.countryCode, 10);
        if (isNaN(countryCode)) {
            countryCode = 22;
            rewriteNeeded = true;
        }

        let price = parseFloat(p.price);
        if (isNaN(price)) {
            price = 0.00;
            rewriteNeeded = true;
        }

        let status = typeof p.status === 'string' ? p.status.trim().toLowerCase() : 'active';
        if (status !== 'active' && status !== 'disabled') {
            status = 'active';
            rewriteNeeded = true;
        }

        if (
            p.id !== id ||
            p.category !== category ||
            p.country !== country ||
            p.countryCode !== countryCode ||
            p.price !== price ||
            p.status !== status
        ) {
            rewriteNeeded = true;
        }

        const validProd = {
            id,
            name: p.name,
            category,
            country,
            countryCode,
            price,
            code: p.code,
            emoji: p.emoji || '📦',
            description: p.description || '',
            status
        };

        validatedProducts.push(validProd);
    }

    if (rewriteNeeded || validatedProducts.length !== products.length) {
        try {
            fs.writeFileSync(productsPath, JSON.stringify(validatedProducts, null, 2), 'utf8');
        } catch (err) {
            console.error('⚠️ Failed to write validated products.json:', err.message);
        }
    }
}

// Trigger safety bootstrapping
try {
    initializeDatabases();
    validateCategoriesFile(db.DB_DIR);
    validateProductsFile(db.DB_DIR);
} catch (err) {
    console.error('⚠️ [STARTUP ERROR] JSON integrity validation failed:', err.message);
}

// User settings helper logic
function getUserPrefs(userId) {
    const settings = db.loadDb('settings.json') || {};
    if (!settings.user_prefs) {
        settings.user_prefs = {};
    }
    if (!settings.user_prefs[userId]) {
        settings.user_prefs[userId] = {
            language: "English",
            notifications: "ENABLED",
            theme: "Dark Premium"
        };
        db.saveDb('settings.json', settings);
    }
    return settings.user_prefs[userId];
}

function saveUserPrefs(userId, prefs) {
    const settings = db.loadDb('settings.json') || {};
    if (!settings.user_prefs) {
        settings.user_prefs = {};
    }
    settings.user_prefs[userId] = prefs;
    db.saveDb('settings.json', settings);
}

function handleSettings(ctx) {
    const userId = ctx.from.id.toString();
    const prefs = getUserPrefs(userId);

    const txt = `⚙️ <b>USER PREFERENCES CONTROL</b>\n─────────────────────────\n` +
        `🌍 Current Language: <b>${prefs.language}</b>\n` +
        `🔔 Status Notifications: <b>${prefs.notifications}</b>\n` +
        `🎨 UI Theme Style: <b>${prefs.theme}</b>\n\n` +
        `Click any parameter below to dynamically cycle options.`;

    const markup = {
        inline_keyboard: [
            [{ text: `🌍 Language: ${prefs.language}`, callback_data: 'user_set_lang' }],
            [{ text: `🔔 Notifications: ${prefs.notifications}`, callback_data: 'user_set_notify' }],
            [{ text: `🎨 Theme: ${prefs.theme}`, callback_data: 'user_set_theme' }],
            [{ text: '⬅️ Back to Menu', callback_data: 'user_main_menu' }]
        ]
    };

    if (ctx.callbackQuery) {
        return ctx.editMessageText(txt, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
    } else {
        return ctx.reply(txt, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
    }
}

async function handleSetLanguage(ctx) {
    const userId = ctx.from.id.toString();
    const prefs = getUserPrefs(userId);
    if (prefs.language === "English") {
        prefs.language = "Hindi";
    } else if (prefs.language === "Hindi") {
        prefs.language = "Russian";
    } else {
        prefs.language = "English";
    }
    saveUserPrefs(userId, prefs);
    await ctx.answerCbQuery(`🌎 Language toggled: ${prefs.language}`).catch(() => {});
    return handleSettings(ctx);
}

async function handleSetNotifications(ctx) {
    const userId = ctx.from.id.toString();
    const prefs = getUserPrefs(userId);
    if (prefs.notifications === "ENABLED") {
        prefs.notifications = "DISABLED";
    } else {
        prefs.notifications = "ENABLED";
    }
    saveUserPrefs(userId, prefs);
    await ctx.answerCbQuery(`🔔 Notifications set: ${prefs.notifications}`).catch(() => {});
    return handleSettings(ctx);
}

async function handleSetTheme(ctx) {
    const userId = ctx.from.id.toString();
    const prefs = getUserPrefs(userId);
    if (prefs.theme === "Dark Premium") {
        prefs.theme = "Blue Elegance";
    } else if (prefs.theme === "Blue Elegance") {
        prefs.theme = "Light Classic";
    } else {
        prefs.theme = "Dark Premium";
    }
    saveUserPrefs(userId, prefs);
    await ctx.answerCbQuery(`🎨 Theme changed: ${prefs.theme}`).catch(() => {});
    return handleSettings(ctx);
}

// ==========================================
// TELEGRAM CLIENT SYSTEM INITIALIZATION
// ==========================================
const bot = new Telegraf(config.BOT_TOKEN);
bot.use(session());

// Initialize Web Diagnostics Server
server.initServer(config.PORT);

// ==========================================
// CRASH-PROOF TELEGRAM MESSAGE PROXY
// ==========================================
bot.use(async (ctx, next) => {
    const originalEdit = ctx.editMessageText;
    ctx.editMessageText = async function (text, extra) {
        try {
            return await originalEdit.call(ctx, text, extra);
        } catch (err) {
            try {
                return await ctx.reply(text, extra);
            } catch (replyErr) {
                logger.error('TELEGRAM_ERROR', `Failed both editMessageText and fallback reply: ${replyErr.message}`, ctx.from?.id);
            }
        }
    };
    return next();
});

// ==========================================
// DUP UPDATE & SESSION MUTEX MIDDLEWARE
// ==========================================
const processedUpdates = new Set();
const handledCallbacks = new Set();

bot.use((ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();

    // 1. Prevent duplicate update processing
    const updateId = ctx.update.update_id;
    if (processedUpdates.has(updateId)) return;
    processedUpdates.add(updateId);
    setTimeout(() => processedUpdates.delete(updateId), 15000);

    // 2. Prevent duplicate callback query processing
    if (ctx.callbackQuery) {
        const cbId = ctx.callbackQuery.id;
        if (handledCallbacks.has(cbId)) return;
        handledCallbacks.add(cbId);
        setTimeout(() => handledCallbacks.delete(cbId), 5000);
    }

    // 3. Clean and isolate step session timeouts (15 minutes expiry)
    if (!ctx.session) ctx.session = {};
    const now = Date.now();
    const expiryWindow = 15 * 60 * 1000;
    
    if (ctx.session.lastActivity && (now - ctx.session.lastActivity > expiryWindow)) {
        ctx.session.step = null;
        ctx.session.editProdId = null;
        ctx.session.editTargetUserId = null;
    }
    ctx.session.lastActivity = now;

    // 4. Rate-Limiting & Flood Mitigation
const settings = db.loadDb('settings.json');

const isAdmin =
    config.isAdmin(ctx.from.id) ||
    (settings.admins &&
     settings.admins.includes(ctx.from.id.toString()));

if (!isAdmin && security.isRateLimited(ctx.from.id)) {
    logger.warn(
        'SECURITY_ALERT',
        'Rate-limiting triggered.',
        ctx.from.id
    );

    return ctx.reply(
        '⚠️ Please slow down your requests.'
    );
}
return next();
});
// ==========================================
// PLATFORM SECURITY & BLOCKS MIDDLEWARE
// ==========================================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    const settings = db.loadDb('settings.json');

    // Reject banned accounts
    if (settings.banned_users && settings.banned_users.includes(userId)) {
        logger.warn('SECURITY_ALERT', 'Banned account attempted interaction.', userId);
        return ctx.reply('❌ You have been banned from using this platform.');
    }

    // Maintenance Mode Lock
    const isAdmin = config.isAdmin(userId) || (settings.admins && settings.admins.includes(userId));
    if (config.isMaintenance() && !isAdmin) {
        return ctx.reply('🛠 <b>MAINTENANCE MODE ACTIVE</b>\n───────────────────────\nThe platform is currently undergoing system upgrades. Normal service will resume shortly.', { parse_mode: 'HTML' });
    }

    return next();
});

// ==========================================
// CORE COMMANDS & KEYBOARD ROUTER
// ==========================================
bot.start(async (ctx) => {
    try {

        const forcejoin = db.loadDb('forcejoin.json') || {
            enabled: true,
            channels: []
        };

        if (
            forcejoin.enabled &&
            forcejoin.channels.length > 0
        ) {

            const buttons = [];

            forcejoin.channels.forEach(ch => {

                if (ch.type === 'public') {
                    buttons.push([
                        {
                            text: `📢 ${ch.username}`,
                            url: `https://t.me/${ch.username.replace('@','')}`
                        }
                    ]);
                }

                if (ch.type === 'private') {
                    buttons.push([
                        {
                            text: '🔒 Join Channel',
                            url: ch.inviteLink
                        }
                    ]);
                }

            });

            buttons.push([
                {
                    text: '✅ Joined',
                    callback_data: 'fj_verify'
                }
            ]);
const payload = ctx.startPayload || ctx.message.text.split(' ')[1];

if (payload) {
    ctx.session.refPayload = payload;

    
}

            return ctx.reply(
                '📢 Please join all required channels before using the bot.',
                {
                    reply_markup: {
                        inline_keyboard: buttons
                    }
                }
            );


        }


        logger.info(
            'USER_JOINED',
            'User launched start sequence.',
            ctx.from.id
        );

        return userHandler.handleStart(ctx);

    } catch (err) {
        logger.error(
            'ERROR',
            `Start command crashed: ${err.message}`,
            ctx.from.id
        );
    }
});

bot.hears('📱 Buy Number', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Buy Number dashboard.', ctx.from.id);
        return orderHandler.renderBuyMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `Buy Number command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('💰 Wallet', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Wallet dashboard.', ctx.from.id);
        return walletHandler.renderWalletMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `Wallet command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('👤 Profile', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Profile metrics.', ctx.from.id);
        return userHandler.handleProfile(ctx);
    } catch (err) {
        logger.error('ERROR', `Profile command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('📦 My Orders', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Active Orders.', ctx.from.id);
        const orders = db.loadDb('orders.json').filter(o => o.userId === ctx.from.id.toString() && o.status === 'WAITING');
        if (orders.length === 0) return ctx.reply('ℹ️ You have no active waiting orders.');
        orders.forEach(o => {
            ctx.reply(`📞 <b>${o.productName}</b> - <code>${o.number}</code> (Pending OTP)`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Pull OTP', callback_data: `order_check_${o.id}` }],
                        [{ text: '❌ Cancel & Refund', callback_data: `order_cancel_${o.id}` }]
                    ]
                }
            });
        });
    } catch (err) {
        logger.error('ERROR', `My Orders command crashed: ${err.message}`, ctx.from.id);
    }
});
    bot.hears('📥 Deposit', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Deposit', ctx.from.id);
        return walletHandler.handleDepositInit(ctx);
    } catch (err) {
        logger.error('ERROR', `Deposit command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('🎁 Referral', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Referral portal.', ctx.from.id);
        return referralHandler.renderReferralMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `Referral command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('⚙ Settings', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Settings dashboard.', ctx.from.id);
        return handleSettings(ctx);
    } catch (err) {
        logger.error('ERROR', `Settings command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('🆘 Support', (ctx) => {
    try {
        logger.info('COMMAND', 'Requested Support desk.', ctx.from.id);
        return userHandler.handleSupport(ctx);
    } catch (err) {
        logger.error('ERROR', `Support command crashed: ${err.message}`, ctx.from.id);
    }
});

bot.hears('💼 Admin Panel', (ctx) => {
    try {
        const settings = db.loadDb('settings.json');
        if (!config.isAdmin(ctx.from.id) && !(settings.admins && settings.admins.includes(ctx.from.id.toString()))) return;
        logger.info('ADMIN_ACTION', 'Accessed Admin Dashboard.', ctx.from.id);
return safeAdminMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `Admin Panel command crashed: ${err.message}`, ctx.from.id);
    }
});

// ==========================================
// INLINE CALLBACK MUTEX ROUTING CONTROLLER
// ==========================================
bot.on('callback_query', async (ctx) => {
    let processed = false;
    try {
        const data = ctx.callbackQuery.data;
await ctx.answerCbQuery("⏳ Loading...").catch(() => {});       
 const userId = ctx.from.id.toString();
        const settings = db.loadDb('settings.json');
        const isAdmin = config.isAdmin(ctx.from.id) || (settings.admins && settings.admins.includes(userId));

        logger.info('CALLBACK', `Executed callback: ${data}`, ctx.from.id);
console.log('CALLBACK DATA =', data);

        ctx.answerCbQuery().catch(() => {});

        // Reject banned accounts in callback processing
        if (settings.banned_users && settings.banned_users.includes(userId)) {
            logger.warn('SECURITY_ALERT', 'Banned account attempted callback interaction.', userId);
            return ctx.reply('❌ You have been banned from using this platform.');
        }

        // ==========================================
        // SaaS ADMINISTRATION CALLBACK SYSTEM
        // ==========================================
if (
   data.startsWith('admin_') ||
   data.startsWith('adm_') ||
   data.startsWith('country_') ||
   data.startsWith('cat_add_') ||
   (data.startsWith('fj_') && data !== 'fj_verify')
) {
          if (!isAdmin) {
                logger.warn('SECURITY_ALERT', 'Unauthorized admin callback access attempt.', userId);
                return ctx.reply('❌ Unauthorized access.');
            }

            if (data === 'admin_menu') {
                processed = true;
                try {
                    return safeAdminMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_menu failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_products') {
                processed = true;
                try {
                    return await adminHandler.renderProductsAdmin(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_products failed: ${err.message}`, ctx.from.id);
                }
            }
if (data.startsWith('adm_prod_view_')) {
    processed = true;

    const prodId = data.replace('adm_prod_view_', '');
const products = db.loadDb('products.json') || [];

const product = products.find(p => p.id === prodId);

if (!product) {
    return ctx.answerCbQuery('❌ Product not found');
}
    return ctx.reply(
`📦 PRODUCT DETAILS

📱 Service : ${product.name}
🌍 Country : ${product.country}
📂 Category : ${product.category}
💰 Price : ₹${Number(product.manualPrice ?? product.price ?? 0).toFixed(2)}
${product.manualPrice != null ? '🔒 Manual Price' : '🌐 API Price'}
🔑 Code : ${product.code}
📊 Status : ${product.status.toUpperCase()}

Select an action below:`,
        {
            reply_markup: {
inline_keyboard: [
    [
        {
            text: '🟢 Enable / Disable',
            callback_data: `adm_prod_toggle_${prodId}`
        },
        {
            text: '💰 Edit Price',
            callback_data: `adm_prod_price_${prodId}`
        }
    ],
    [
        {
            text: '🌍 Change Country',
            callback_data: `adm_prod_country_${prodId}`
        },
        {
            text: '📁 Change Category',
            callback_data: `adm_prod_category_${prodId}`
        }
    ],
    [
        {
            text: '🔑 Change Service Code',
            callback_data: `adm_prod_code_${prodId}`
        },
        {
            text: '✏️ Edit Name',
            callback_data: `adm_prod_name_${prodId}`
        }
    ],
    [
        {
            text: '📝 Edit Description',
            callback_data: `adm_prod_desc_${prodId}`
        },
        {
            text: '😀 Change Emoji',
            callback_data: `adm_prod_emoji_${prodId}`
        }
    ],
    [
        {
            text: '👯 Duplicate',
            callback_data: `adm_prod_copy_${prodId}`
        },
        {
            text: '❌ Delete',
            callback_data: `adm_prod_del_${prodId}`
        }
    ],
    [
        {
            text: '⬅️ Back',
            callback_data: 'admin_products'
        }
    ]
]
            }
        }
    );
}
            if (data === 'admin_categories') {
                processed = true;
                try {
                    return await adminHandler.renderCategoryManagerMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_categories failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_countries') {
                processed = true;
                try {
                    return await adminHandler.renderCountryManagerMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_countries failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_services') {
                processed = true;
                try {
                    return await adminHandler.renderServiceManagerMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_services failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_recharges') {
                processed = true;
                try {
                    return await adminHandler.renderRechargeQueue(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_recharges failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_withdraws') {
                processed = true;
                try {
                    return await adminHandler.renderWithdrawQueue(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_withdraws failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_providers') {
                processed = true;
                try {
                    return await adminHandler.renderProvidersAdmin(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_providers failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_fraud_center') {
                processed = true;
                try {
                    return await adminHandler.renderFraudCenter(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_fraud_center failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_configs') {
                processed = true;
                try {
                    return await adminHandler.renderConfigsAdmin(ctx);
                } catch (err) {

                    logger.error('CALLBACK_ERROR', `admin_configs failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'adm_cfg_profit_init') {
    processed = true;
    ctx.session.step = 'ADM_CFG_PROFIT';
    await ctx.answerCbQuery().catch(() => {});
    return ctx.reply('💰 Enter new profit percentage (Example: 10)');
}

if (
    data.startsWith('fj_') &&
    data !== 'fj_verify'
) {
    if (!isAdmin) {
return ctx.reply('❌ Unauthorized access.');
    }
}
if (data === 'ignore') {
    processed = true;
    return ctx.answerCbQuery();
}
if (data === 'admin_forcejoin') {
    processed = true;
    try {
        const forcejoin = db.loadDb('forcejoin.json') || {
            enabled: true,
            channels: []
        };

        let txt =
`📢 <b>FORCE JOIN MANAGER</b>

Status: ${forcejoin.enabled ? '🟢 ENABLED' : '🔴 DISABLED'}

Channels: ${forcejoin.channels.length}

Manage force join channels below.`;

        return ctx.editMessageText(txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '➕ Add Channel',
                            callback_data: 'fj_add_channel'
                        }
                    ],
                    [
                        {
                            text: '📋 Channel List',
                            callback_data: 'fj_list'
                        }
                    ],
                    [
                        {
                            text: forcejoin.enabled
                                ? '🔴 Disable'
                                : '🟢 Enable',
                            callback_data: 'fj_toggle'
                        }
                    ],
                    [
                        {
                            text: '⬅️ Back',
                            callback_data: 'admin_menu'
                        }
                    ]
                ]
            }
        });

    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `admin_forcejoin failed: ${err.message}`,
            ctx.from.id
        );
    }
}

if (data === 'fj_add_channel') {
    processed = true;

    ctx.session.step = 'FJ_SELECT_TYPE';

return ctx.editMessageText(
        '📢 Select Channel Type',
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🌐 Public Channel',
                            callback_data: 'fj_public'
                        }
                    ],
                    [
                        {
                            text: '🔒 Private Channel',
                            callback_data: 'fj_private'
                        }
                    ],
                    [
                        {
                            text: '⬅️ Back',
                            callback_data: 'admin_forcejoin'
                        }
                    ]
                ]
            }
        }
    );
}

if (data === 'fj_public') {
    processed = true;

    ctx.session.step = 'FJ_PUBLIC_USERNAME';

    console.log(
        'DEBUG STEP:',
        ctx.session.step
    );

    return ctx.reply(
        '🌐 Send Public Channel Username\n\nExample:\n@mychannel'
    );
}
if (data === 'fj_private') {
    processed = true;

    ctx.session.step = 'FJ_PRIVATE_ID';

    console.log(
        'DEBUG STEP:',
        ctx.session.step
    );

    return ctx.reply(
        '🔒 Send Private Channel ID\n\nExample:\n-1001234567890'
    );
}
if (data === 'fj_toggle') {
    processed = true;

    const forcejoin = db.loadDb('forcejoin.json') || {
        enabled: true,
        channels: []
    };

    forcejoin.enabled = !forcejoin.enabled;

    db.saveDb('forcejoin.json', forcejoin);

    return ctx.reply(
        forcejoin.enabled
            ? '✅ Force Join Enabled'
            : '❌ Force Join Disabled'
    );
}
if (data === 'fj_list') {
    processed = true;

    const forcejoin = db.loadDb('forcejoin.json') || {
        enabled: true,
        channels: []
    };

    if (forcejoin.channels.length === 0) {
        return ctx.reply('❌ No force join channels found.');
    }

    let txt = '📋 FORCE JOIN CHANNELS\n\n';
    const buttons = [];

    forcejoin.channels.forEach((ch, index) => {

        if (ch.type === 'public') {
            txt += `${index + 1}. 🌐 ${ch.username}\n`;
        } else {
            txt += `${index + 1}. 🔒 ${ch.channelId}\n`;
        }

        buttons.push([
            {
                text: `🗑 Delete #${index + 1}`,
                callback_data: `fj_delete_${index}`
            }
        ]);
    });

    buttons.push([
        {
            text: '⬅️ Back',
            callback_data: 'admin_forcejoin'
        }
    ]);

    return ctx.reply(txt, {
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

if (data.startsWith('fj_delete_')) {
    processed = true;

    const index = parseInt(
        data.replace('fj_delete_', '')
    );

    const forcejoin = db.loadDb('forcejoin.json') || {
        enabled: true,
        channels: []
    };

    if (
        !isNaN(index) &&
        forcejoin.channels[index]
    ) {
        forcejoin.channels.splice(index, 1);

        db.saveDb(
            'forcejoin.json',
            forcejoin
        );

        return ctx.reply(
            '✅ Channel deleted successfully.'
        );
    }

    return ctx.reply(
        '❌ Invalid channel.'
    );
}
            // ===== ADMIN SETTINGS CALLBACKS =====
            if (data === 'adm_cfg_botname_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_BOTNAME';
                    return ctx.reply('🤖 Enter new Platform Name:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_botname_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cfg_support_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_SUPPORT';
                    return ctx.reply('💬 Enter Support Handle (without @):');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_support_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cfg_currency_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_CURRENCY';
                    return ctx.reply('💳 Enter Currency Symbol (Example: ₹):');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_currency_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cfg_ref_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_REF';
                    return ctx.reply('🎁 Enter Referral Percentage:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_ref_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cfg_min_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_MIN';
                    return ctx.reply('📥 Enter Minimum Deposit Amount:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_min_init failed: ${err.message}`, ctx.from.id);
                }
            }
if (data === 'adm_cfg_upi_init') {
    processed = true;

    ctx.session.step = 'ADM_CFG_UPI';

    return ctx.reply('🏦 Send New UPI ID');
}

            if (data === 'adm_cfg_timeout_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_CFG_TIMEOUT';
                    return ctx.reply('⏱ Enter Order Timeout (seconds):');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_timeout_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cfg_maint_toggle') {
                processed = true;
                try {
                    settings.maintenance_mode = !settings.maintenance_mode;
                    db.saveDb('settings.json', settings);
                    return await adminHandler.renderConfigsAdmin(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cfg_maint_toggle failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'admin_backup') {
                processed = true;
                try {
                    return await adminHandler.handleSystemBackup(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_backup failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'admin_stats') {
                processed = true;
                try {
                    return await adminHandler.renderAdminStats(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_stats failed: ${err.message}`, ctx.from.id);
                }
            }
if (data === 'admin_users') {
    processed = true;
    try {

        const users = db.loadDb('users.json') || {};

        let txt =
`👥 <b>USER MANAGEMENT</b>

Select a user below:`;

        const buttons = [];

        Object.values(users).forEach(user => {

            buttons.push([
                {
                    text: `👤 ${user.first_name || 'Unknown'} | ${user.id}`,
                    callback_data: `adm_user_view_${user.id}`
                }
            ]);

        });

        buttons.push([
            {
                text: '🔍 Search User',
                callback_data: 'adm_user_search'
            }
        ]);

        buttons.push([
            {
                text: '⬅️ Back',
                callback_data: 'admin_menu'
            }
        ]);

        return ctx.editMessageText(
            txt,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );

    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `admin_users failed: ${err.message}`,
            ctx.from.id
        );
    }
}         
if (data === 'adm_user_search') {

    processed = true;

    try {

        ctx.session.step =
            'ADM_USER_SEARCH';

        return ctx.reply(
            '🔍 Enter User ID:'
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_user_search failed: ${err.message}`,
            ctx.from.id
        );

    }
}

             if (data === 'admin_broadcast_init') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_BROADCAST_TEXT';
                    return ctx.reply('📣 Enter broadcast alert details:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_broadcast_init failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'admin_logs') {
                processed = true;
                try {
                    return await adminHandler.renderAuditLogs(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `admin_logs failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- Product Wizard Initiation ---
            if (data === 'adm_prod_add_init') {
                processed = true;
                try {
                    return await adminHandler.handleProductAddInit(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_add_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_cat_add') {
                processed = true;
                try {
                    return await adminHandler.handleCategoryAddInit(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cat_add failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_cat_del_')) {
                processed = true;
                try {
                    const idx = data.replace('adm_cat_del_', '');
                    return await adminHandler.handleCategoryDelete(ctx, idx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cat_del failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_cat_ren_init_')) {
                processed = true;
                try {
                    const idx = data.replace('adm_cat_ren_init_', '');
                    return await adminHandler.handleCategoryRenameInit(ctx, idx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_cat_ren_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_country_add') {
                processed = true;
                try {
                    return await adminHandler.handleCountryAddInit(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_country_add failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_country_del_')) {
                processed = true;
                try {
                    const idx = data.replace('adm_country_del_', '');
                    return await adminHandler.handleCountryDelete(ctx, idx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_country_del failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_svc_sub_')) {
                processed = true;
                try {
                    const idx = data.replace('adm_svc_sub_', '');
                    return await adminHandler.renderServiceSubmenu(ctx, idx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_svc_sub failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_svc_del_')) {
                processed = true;
                try {
                    const idx = parseInt(data.replace('adm_svc_del_', ''), 10);
                    const services = db.loadDb('services.json') || [];
                    if (services[idx] !== undefined) {
                        const deletedName = services[idx].name;
                        services.splice(idx, 1);
                        db.saveDb('services.json', services);
                        await ctx.answerCbQuery(`Deleted service: ${deletedName}`).catch(() => {});
                    }
                    return await adminHandler.renderServiceManagerMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_svc_del failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_svc_add') {
                processed = true;
                try {
                    ctx.session.adminState = 'awaiting_service_name';
                    await ctx.answerCbQuery().catch(() => {});
                    return await ctx.reply('➕ Please enter the name of the new custom Service:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_svc_add failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prov_add_init') {
                processed = true;
                try {
                    ctx.session.adminState = 'ADM_PROV_ADD_NAME';
                    await ctx.answerCbQuery().catch(() => {});
                    return await ctx.reply('🔌 Enter Provider Display Name:');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prov_add_init failed: ${err.message}`, ctx.from.id);
                }
            }

            // Admin Category Selection Handler
            if (data.startsWith('cat_add_')) {
                processed = true;
                try {
                    const category = data.replace('cat_add_', '');
                    ctx.session.newProduct = ctx.session.newProduct || {};
                    ctx.session.newProduct.category = category;
                    ctx.session.step = 'ADM_PROD_SELECT_COUNTRY';

                    return ctx.reply(
                        '🌍 Select Country',
                        {
                            reply_markup: {
inline_keyboard: (() => {
    const countries = db.loadDb('countries_db.json') || [];
    const rows = [];

    for (let i = 0; i < countries.length; i += 2) {
        const row = [];

        const c1 = countries[i];
        if (c1 && c1.enabled) {
            row.push({
                text: `${c1.emoji || "🌍"} ${c1.name}`,
                callback_data: `country_${c1.id}_${c1.name}`
            });
        }

        const c2 = countries[i + 1];
        if (c2 && c2.enabled) {
            row.push({
               text: `${c2.emoji || "🌍"} ${c2.name}`,
                callback_data: `country_${c2.id}_${c2.name}`
            });
        }

        if (row.length) rows.push(row);
    }

    rows.push([
        {
            text: '🔍 Search Country',
            callback_data: 'country_search'
        }
    ]);

    return rows;
})()

                            }
                        }
                    );
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `cat_add_dynamic failed: ${err.message}`, ctx.from.id);
                }
            }

            // Wizard Country Routing Fallbacks
            if (data === 'country_search') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_SEARCH_COUNTRY';
                    return ctx.reply(
                        '🔍 Send Country Name\n\nExample:\nIndia\nCanada\nAustralia'
                    );
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `country_search failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('country_') && data !== 'country_search') {
                processed = true;
                try {
                    const parts = data.split('_');
                    ctx.session.newProduct = ctx.session.newProduct || {};
                    ctx.session.newProduct.countryCode = parseInt(parts[1], 10);
                    ctx.session.newProduct.country = parts.slice(2).join('_');
                    ctx.session.step = 'ADM_PROD_ADD_NAME';

                    return adminHandler.renderWizardStep(
                        ctx,
                        3,
                        '📱 Enter Service Name (Example: Telegram, WhatsApp, Google):'
                    );
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `country_select failed: ${err.message}`, ctx.from.id);
                }
            }
if (data.startsWith('adm_prod_country_set_')) {
    processed = true;

    try {
        const value = data.replace('adm_prod_country_set_', '');
        const pos = value.lastIndexOf('_');

        const prodId = value.substring(0, pos);
        const countryId = value.substring(pos + 1);

        const countries = db.loadDb('countries_db.json') || [];
        const products = db.loadDb('products.json') || [];

        const country = countries.find(c =>
            String(c.id || c.code) === String(countryId)
        );

        const index = products.findIndex(p => p.id === prodId);

        if (index === -1 || !country) {
            return ctx.answerCbQuery('❌ Product/Country not found');
        }

        products[index].country = country.name;
        products[index].countryCode = country.id || country.code;

db.saveDb('products.json', products);
await ctx.answerCbQuery(
    `✅ Country changed to ${country.name}`,
    {
        show_alert: false
    }
);

ctx.callbackQuery.data = `adm_prod_view_${prodId}`;
return;

    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_country_set_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}
if (data.startsWith('adm_prod_category_set_')) {
    processed = true;

    try {
        const value = data.replace('adm_prod_category_set_', '');
        const pos = value.lastIndexOf('_');

        const prodId = value.substring(0, pos);
        const category = decodeURIComponent(value.substring(pos + 1));

        const products = db.loadDb('products.json') || [];
        const index = products.findIndex(p => p.id === prodId);

        if (index === -1) {
            return ctx.answerCbQuery('❌ Product not found');
        }

        products[index].category = category;

        db.saveDb('products.json', products);

        await ctx.answerCbQuery(
    `✅ Category changed to ${category}`,
    {
        show_alert: false
    }
);

        ctx.callbackQuery.data = `adm_prod_view_${prodId}`;
        return;
    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_category_set_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}


            if (data.startsWith('adm_prod_toggle_')) {
                processed = true;
                try {
                    const prodId = data.replace('adm_prod_toggle_', '');
                    const products = db.loadDb('products.json');
                    const idx = products.findIndex(p => p.id === prodId);
                    if (idx !== -1) {
                        products[idx].status = products[idx].status === 'active' ? 'disabled' : 'active';
                        db.saveDb('products.json', products);
console.log('DELETE TEST:', prodId, products.length);                        
return await adminHandler.renderProductsAdmin(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_toggle_ failed: ${err.message}`, ctx.from.id);
                }
            }

if (data.startsWith('adm_prod_price_manual_')) {
    processed = true;

    try {
        const prodId = data.replace('adm_prod_price_manual_', '');

        ctx.session.editProdId = prodId;
        ctx.session.step = 'ADM_PROD_EDIT_PRICE';

        return ctx.reply('💰 Enter new manual price:');
    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_price_manual_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}
if (data.startsWith('adm_prod_price_auto_')) {
    processed = true;

    try {
        const prodId = data.replace('adm_prod_price_auto_', '');

        const products = db.loadDb('products.json') || [];

        const index = products.findIndex(
            p => p.id === prodId
        );

        if (index === -1) {
            return ctx.answerCbQuery('❌ Product not found');
        }

        products[index].manualPrice = null;

db.saveDb('products.json', products);

await ctx.answerCbQuery('✅ API Price Enabled');
await ctx.reply(
    '✅ API Price Enabled Successfully.'
);

return;

return adminHandler.renderProductDetails(ctx, prodId);


    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_price_auto_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}
if (data.startsWith('adm_prod_price_')) {
    processed = true;
    try {
        const prodId = data.replace('adm_prod_price_', '');
        ctx.session.editProdId = prodId;

        return ctx.reply(
            `💰 <b>Price Settings</b>\n\nChoose an option:`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "💵 Set Manual Price",
                                callback_data: `adm_prod_price_manual_${prodId}`
                            }
                        ],
                        [
                            {
                                text: "♻️ Use API Price",
                                callback_data: `adm_prod_price_auto_${prodId}`
                            }
                        ],
                        [
                            {
                                text: "⬅️ Back",
                               callback_data: `adm_prod_view_${prodId}`
                            }
                        ]
                    ]
                }
            }
        );
    } catch (err) {
        logger.error('CALLBACK_ERROR', `adm_prod_price_ failed: ${err.message}`, ctx.from.id);
    }
}
if (data.startsWith('adm_prod_name_')) {
    processed = true;
    try {
        const prodId = data.replace('adm_prod_name_', '');

        ctx.session.editProdId = prodId;
        ctx.session.step = 'ADM_PROD_EDIT_NAME';

        return ctx.reply('✏️ Enter new product name:');
    } catch (err) {
        logger.error('CALLBACK_ERROR', `adm_prod_name_ failed: ${err.message}`, ctx.from.id);
    }
}
if (data.startsWith('adm_prod_country_')) {
    processed = true;

    const prodId = data.replace('adm_prod_country_', '');

    ctx.session.editProdId = prodId;
    ctx.session.step = 'ADM_PROD_EDIT_COUNTRY';

    const countries = db.loadDb('countries_db.json') || [];
    const rows = [];

    for (let i = 0; i < countries.length; i += 2) {
        const row = [];

        const c1 = countries[i];
        if (c1 && c1.enabled) {
            row.push({
                text: `${c1.emoji || '🌍'} ${c1.name}`,
                callback_data: `adm_prod_country_set_${prodId}_${c1.id || c1.code}`
            });
        }

        const c2 = countries[i + 1];
        if (c2 && c2.enabled) {
            row.push({
                text: `${c2.emoji || '🌍'} ${c2.name}`,
                callback_data: `adm_prod_country_set_${prodId}_${c2.id || c2.code}`
            });
        }

        if (row.length) rows.push(row);
    }

    rows.push([
        {
            text: '🔍 Search Country',
            callback_data: `adm_prod_country_search_${prodId}`
        }
    ]);

    rows.push([
        {
            text: '⬅️ Back',
            callback_data: `adm_prod_view_${prodId}`
        }
    ]);

    return ctx.reply(
        '🌍 <b>Select New Country</b>',
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: rows
            }
        }
    );
}
if (data.startsWith('adm_prod_category_')) {
    processed = true;

    const prodId = data.replace('adm_prod_category_', '');

    const categories = db.loadDb('categories.json') || [];
    const rows = [];

    for (let i = 0; i < categories.length; i += 2) {
        const row = [];

        if (categories[i]) {
            row.push({
                text: `📁 ${typeof categories[i] === 'object' ? categories[i].name : categories[i]}`,
                callback_data: `adm_prod_category_set_${prodId}_${encodeURIComponent(typeof categories[i] === 'object' ? categories[i].name : categories[i])}`
            });
        }

        if (categories[i + 1]) {
            row.push({
                text: `📁 ${typeof categories[i + 1] === 'object' ? categories[i + 1].name : categories[i + 1]}`,
                callback_data: `adm_prod_category_set_${prodId}_${encodeURIComponent(typeof categories[i + 1] === 'object' ? categories[i + 1].name : categories[i + 1])}`
            });
        }

        rows.push(row);
    }

    rows.push([
        {
            text: '⬅️ Back',
            callback_data: `adm_prod_view_${prodId}`
        }
    ]);

    return ctx.reply(
        '📁 <b>Select Category</b>',
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: rows
            }
        }
    );
}

if (data.startsWith('adm_prod_code_')) {
    processed = true;

    const prodId = data.replace('adm_prod_code_', '');

    ctx.session.editProdId = prodId;
    ctx.session.step = 'ADM_PROD_EDIT_CODE';

    return ctx.reply('🔑 Enter new service code:');
}

if (data.startsWith('adm_prod_emoji_')) {
    processed = true;

    const prodId = data.replace('adm_prod_emoji_', '');

    ctx.session.editProdId = prodId;
    ctx.session.step = 'ADM_PROD_EDIT_EMOJI';

    return ctx.reply('😀 Send new emoji:');
}
if (
    data.startsWith('adm_prod_desc_') &&
    !data.startsWith('adm_prod_desc_default_') &&
    !data.startsWith('adm_prod_desc_manual_')
) {
    processed = true;
    try {
        const prodId = data.replace('adm_prod_desc_', '');

        return ctx.reply(
            '📝 Description Settings',
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🟢 Default',
                                callback_data: `adm_prod_desc_default_${prodId}`
                            }
                        ],
                        [
                            {
                                text: '✍️ Manual',
                                callback_data: `adm_prod_desc_manual_${prodId}`
                            }
                        ],
                        [
                            {
                                text: '⬅️ Back',
                                callback_data: 'admin_products'
                            }
                        ]
                    ]
                }
            }
        );
    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_desc_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}
if (data.startsWith('adm_prod_desc_default_')) {
    processed = true;

    const prodId = data.replace('adm_prod_desc_default_', '');
    const products = db.loadDb('products.json');

    const product = products.find(p => p.id === prodId);

    if (product) {
        product.description =
`✅ Instant OTP Delivery
⚡ Auto SMS Receive
🛡️ Fresh Number
♻️ Refund Available`;
        db.saveDb('products.json', products);
    }

    return ctx.reply('✅ Default description applied.');
}

if (data.startsWith('adm_prod_desc_manual_')) {
    processed = true;

    ctx.session.editProdId = data.replace('adm_prod_desc_manual_', '');
    ctx.session.step = 'ADM_PROD_EDIT_DESC';

    return ctx.reply('📝 Send new description:');
}

            if (data.startsWith('adm_prod_copy_')) {
                processed = true;
                try {
                    const prodId = data.replace('adm_prod_copy_', '');
                    const products = db.loadDb('products.json');
                    const prod = products.find(p => p.id === prodId);
if (prod) {
                        const duplicate = { ...prod, id: 'prod_' + Math.random().toString(36).substring(2, 9), name: `${prod.name} (Copy)` };
                        products.push(duplicate);
                        db.saveDb('products.json', products);
                        return await adminHandler.renderProductsAdmin(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_copy_ failed: ${err.message}`, ctx.from.id);
                }
            }

if (
    data.startsWith('adm_prod_del_') &&
    !data.startsWith('adm_prod_del_yes_')
) {
    processed = true;

    const prodId = data.replace('adm_prod_del_', '');
    const products = db.loadDb('products.json');
    const product = products.find(p => p.id === prodId);

    if (!product) {
        return ctx.answerCbQuery('❌ Product not found');
    }

    return ctx.editMessageText(
`⚠️ <b>Delete Product?</b>

📦 ${product.name}
🌍 ${product.country || 'Unknown'}
💰 ${product.price}`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Yes Delete',
                            callback_data: `adm_prod_del_yes_${prodId}`
                        }
                    ],
                    [
                        {
                            text: '❌ Cancel',
                            callback_data: `adm_prod_view_${prodId}`
                        }
                    ]
                ]
            }
        }
    );
}
if (data.startsWith('adm_prod_del_yes_')) {
    processed = true;

    try {
        const prodId = data.replace('adm_prod_del_yes_', '');

        let products = db.loadDb('products.json');
        products = products.filter(p => p.id !== prodId);

        db.saveDb('products.json', products);

        return await adminHandler.renderProductsAdmin(ctx);

    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `adm_prod_del_yes_ failed: ${err.message}`,
            ctx.from.id
        );
    }
}

            // --- Product Wizard Back Buttons ---
            if (data === 'adm_prod_back_step2') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_ADD_NAME';
                    return await adminHandler.renderWizardStep(ctx, 3, '📱 Enter Service Name (Example: Telegram, WhatsApp, Google):');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_back_step2 failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prod_back_step3') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_ADD_EMOJI';
                    return await adminHandler.renderWizardStep(ctx, 4, 'Enter dynamic emoji display layout icon for this product:', 'adm_prod_back_step2');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_back_step3 failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prod_back_step4') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_ADD_PRICE';
                    return await adminHandler.renderWizardStep(ctx, 5, 'Enter unit product price (₹) (e.g. 15.50):', 'adm_prod_back_step3');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_back_step4 failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prod_back_step5' || data === 'adm_prod_back_step6') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_ADD_DESC';
                    return await adminHandler.renderWizardStep(ctx, 6, 'Enter a description for this product (e.g. Virtual line bypass):', 'adm_prod_back_step4');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_back_step5 failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prod_back_step7') {
                processed = true;
                try {
                    ctx.session.step = 'ADM_PROD_ADD_CODE';
                    return await adminHandler.renderWizardStep(ctx, 7, 'Enter Provider Service mapping code (e.g. tg, wa, go):', 'adm_prod_back_step6');
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_back_step7 failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'adm_prod_add_confirm') {
                processed = true;
                try {
                    const products = db.loadDb('products.json');
                    ctx.session.newProduct = ctx.session.newProduct || {};
                    const newProd = {
    id: 'prod_' + Math.random().toString(36).substring(2, 9),

    price: 0,
    manualPrice: null,

    ...ctx.session.newProduct,

    status: 'active',
    order: products.length + 1
};
                    products.push(newProd);
                    db.saveDb('products.json', products);

                    ctx.session.step = null;
                    ctx.session.newProduct = null;
                    return await adminHandler.renderProductSuccess(ctx, newProd);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prod_add_confirm failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- Deposit approvals ---
            if (data.startsWith('adm_pay_app_')) {
                processed = true;
                try {
                    const reqId = data.replace('adm_pay_app_', '');
                    const payments = settings.pending_payments || [];
                    const payIdx = payments.findIndex(p => p.id === reqId);

                    if (payIdx !== -1) {
                        const req = payments[payIdx];
                        payments.splice(payIdx, 1);
                        settings.pending_payments = payments;
                        db.saveDb('settings.json', settings);

                        const wallets = db.loadDb('wallet.json');
                        const w = wallets[req.userId] || { balance: 0.0, history: [] };
                        w.balance += req.amount;
                        w.history.push({
                            type: 'RECHARGE_CREDIT',
                            amount: req.amount,
                            timestamp: new Date().toISOString(),
                            description: `Recharge confirmation of payment UTR: ${req.utr}`
                        });
                        wallets[req.userId] = w;
                        db.saveDb('wallet.json', wallets);

                        logger.info('ADMIN_ACTION', `Approved deposit ₹${req.amount} for user ID ${req.userId}`, config.ADMIN_ID);
                        await bot.telegram.sendMessage(req.userId, `🎉 <b>RECHARGE VERIFIED</b>\n─────────────────────────\n💰 Credited: <b>${settings.currency}${req.amount.toFixed(2)}</b>\n📝 Reference Code: <code>${req.utr}</code>\n\nYour balance is now updated. Thank you!`, { parse_mode: 'HTML' }).catch(() => {});
                        
                        await referralHandler.processReferralCommission(bot, req.userId, req.amount);
                        await ctx.editMessageText(`✅ Approved and verified payment request ID ${reqId}.`);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_pay_app_ failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_pay_rej_')) {
                processed = true;
                try {
                    const reqId = data.replace('adm_pay_rej_', '');
                    const payments = settings.pending_payments || [];
                    const payIdx = payments.findIndex(p => p.id === reqId);

                    if (payIdx !== -1) {
                        const req = payments[payIdx];
                        payments.splice(payIdx, 1);
                        settings.pending_payments = payments;
                        db.saveDb('settings.json', settings);

                        logger.info('ADMIN_ACTION', `Rejected deposit of ₹${req.amount} from user ID ${req.userId}`, config.ADMIN_ID);
                        await bot.telegram.sendMessage(req.userId, `❌ <b>RECHARGE DECLINED</b>\n─────────────────────────\nYour payment reference ${settings.currency}${req.amount} has been rejected. Please verify with Support.`, { parse_mode: 'HTML' }).catch(() => {});

                        await ctx.editMessageText(`❌ Rejected and deleted payment reference ID ${reqId}.`);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_pay_rej_ failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- Withdrawals approvals ---
            if (data.startsWith('adm_wtd_app_')) {
                processed = true;
                try {
                    const reqId = data.replace('adm_wtd_app_', '');
                    const withdrawals = settings.pending_withdrawals || [];
                    const payIdx = withdrawals.findIndex(w => w.id === reqId);

                    if (payIdx !== -1) {
                        const req = withdrawals[payIdx];
                        withdrawals.splice(payIdx, 1);
                        settings.pending_withdrawals = withdrawals;
                        db.saveDb('settings.json', settings);

                        const wallets = db.loadDb('wallet.json');
                        const w = wallets[req.userId];
                        w.history.push({
                            type: 'WITHDRAWAL_PAID',
                            amount: req.amount,
                            timestamp: new Date().toISOString(),
                            description: `Withdrawal successfully paid to: ${req.details}`
                        });
                        wallets[req.userId] = w;
                        db.saveDb('wallet.json', wallets);
 
const referrals =
    db.loadDb('referrals.json') || {};

if (referrals[req.userId]) {

    if (!referrals[req.userId].earnings) {
        referrals[req.userId].earnings = {
            total: 0,
            pending: 0,
            paid: 0
        };
    }

referrals[req.userId].earnings.pending =
    Math.max(
        0,
        referrals[req.userId].earnings.pending - req.amount
    );

referrals[req.userId].earnings.paid =
    (referrals[req.userId].earnings.paid || 0)
    + req.amount;

    db.saveDb(
        'referrals.json',
        referrals
    );
}
                        logger.info('ADMIN_ACTION', `Approved withdrawal of ₹${req.amount} for user ID ${req.userId}`, config.ADMIN_ID);
                        await bot.telegram.sendMessage(req.userId, `🎉 <b>WITHDRAWAL PAID SUCCESSFULLY</b>\n─────────────────────────\n💰 Paid: <b>${settings.currency}${req.amount.toFixed(2)}</b>\n📝 Details: <code>${req.details}</code>\n\nYour withdrawal has been successfully validated.`, { parse_mode: 'HTML' }).catch(() => {});

                        await ctx.editMessageText(`✅ Approved and finalized withdrawal reference ID ${reqId}.`);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_wtd_app_ failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('adm_wtd_rej_')) {
                processed = true;
                try {
                    const reqId = data.replace('adm_wtd_rej_', '');
                    const withdrawals = settings.pending_withdrawals || [];
                    const payIdx = withdrawals.findIndex(w => w.id === reqId);

                    if (payIdx !== -1) {
                        const req = withdrawals[payIdx];
                        withdrawals.splice(payIdx, 1);
                        settings.pending_withdrawals = withdrawals;
                        db.saveDb('settings.json', settings);

                        const wallets = db.loadDb('wallet.json');
                        const w = wallets[req.userId];
                        w.balance += req.amount;
                        w.history.push({
                            type: 'WITHDRAWAL_REJECT',
                            amount: req.amount,
                            timestamp: new Date().toISOString(),
                            description: 'Withdrawal rejected: Balance returned to wallet.'
                        });
                        wallets[req.userId] = w;
                        db.saveDb('wallet.json', wallets);
const referrals =
    db.loadDb('referrals.json') || {};

if (referrals[req.userId]) {

    if (!referrals[req.userId].earnings) {
        referrals[req.userId].earnings = {
            total: 0,
            pending: 0,
            paid: 0
        };
    }

    referrals[req.userId].earnings.pending =
        Math.max(
            0,
            referrals[req.userId].earnings.pending - req.amount
        );

    referrals[req.userId].earnings.total +=
        req.amount;

    db.saveDb(
        'referrals.json',
        referrals
    );
}


                        logger.info('ADMIN_ACTION', `Rejected withdrawal of ₹${req.amount} from user ID ${req.userId}`, config.ADMIN_ID);
                        await bot.telegram.sendMessage(req.userId, `❌ <b>WITHDRAWAL REJECTED</b>\n─────────────────────────\nYour withdrawal request for ${settings.currency}${req.amount} has been rejected. Funds have been returned to your wallet.`, { parse_mode: 'HTML' }).catch(() => {});

                        await ctx.editMessageText(`❌ Rejected and cancelled withdrawal request ID ${reqId}.`);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_wtd_rej_ failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- Fraud queue ---
            if (data.startsWith('adm_fraud_app_')) {
                processed = true;
                try {
                    const flagId = data.replace('adm_fraud_app_', '');
                    const flagged = db.loadDb('flaggedReferrals.json');
                    const idx = flagged.findIndex(f => f.id === flagId);

                    if (idx !== -1) {
                        const flag = flagged[idx];
                        flagged.splice(idx, 1);
                        db.saveDb('flaggedReferrals.json', flagged);

                        const wallets = db.loadDb('wallet.json');
                        const rWallet = wallets[flag.referrerId];
                        if (rWallet) {
                            rWallet.balance += flag.amount;
                            rWallet.history.push({
                                type: 'REFERRAL_COMMISSION',
                                amount: flag.amount,
                                timestamp: new Date().toISOString(),
                                description: `Authorized flagged commission for referee ${flag.refereeId}`
                            });
                            wallets[flag.referrerId] = rWallet;
                            db.saveDb('wallet.json', wallets);
                        }

                        const referrals = db.loadDb('referrals.json');
                        const refRecord = referrals[flag.referrerId];
                        if (refRecord) {
                            refRecord.earnings = refRecord.earnings || { total: 0, pending: 0, paid: 0 };
                            refRecord.earnings.total += flag.amount;
                            refRecord.earnings.paid += flag.amount;
                            const uIdx = refRecord.referredUsers.findIndex(u => u.userId === flag.refereeId);
                            if (uIdx !== -1) {
                                refRecord.referredUsers[uIdx].status = 'DEPOSITED';
                                refRecord.referredUsers[uIdx].earned = flag.amount;
                            }
                            referrals[flag.referrerId] = refRecord;
                            db.saveDb('referrals.json', referrals);
                        }

                        logger.info('FRAUD_OVERRIDE_APPROVE', `Authorized flagged affiliate commission to referrer ID ${flag.referrerId}`, config.ADMIN_ID);
                        return await adminHandler.renderFraudCenter(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_fraud_app_ failed: ${err.message}`, ctx.from.id);
                }
            }

if (data.startsWith('adm_fraud_rej_')) {
                processed = true;
                try {
                    const flagId = data.replace('adm_fraud_rej_', '');
                    const flagged = db.loadDb('flaggedReferrals.json');
                    const idx = flagged.findIndex(f => f.id === flagId);

                    if (idx !== -1) {
                        flagged.splice(idx, 1);
                        db.saveDb('flaggedReferrals.json', flagged);
                        
                        logger.info('FRAUD_OVERRIDE_REJECT', `Declined flagged commission ID ${flagId}`, config.ADMIN_ID);
                        return await adminHandler.renderFraudCenter(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_fraud_rej_ failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- Provider configs ---
            if (data.startsWith('adm_prov_toggle_')) {
                processed = true;
                try {
                    const provId = data.replace('adm_prov_toggle_', '');
                    const providers = db.loadDb('providers.json');
                    const idx = providers.findIndex(p => p.id === provId);
                    if (idx !== -1) {
                        providers[idx].status = providers[idx].status === 'active' ? 'disabled' : 'active';
                        db.saveDb('providers.json', providers);
                        return await adminHandler.renderProvidersAdmin(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prov_toggle_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_prov_test_')) {
                processed = true;
                try {
                    const provId = data.replace('adm_prov_test_', '');
                    const providers = db.loadDb('providers.json');
                    const p = providers.find(prov => prov.id === provId);
                    if (p) {
                        try {
                            const testRes = await providerService.testProvider(p.id);
                            if (testRes.success) {
                                return ctx.reply(`✅ <b>Provider Health Check Status: HEALTHY</b>\n─────────────────────────\n📊 Response Balance: <b>${settings.currency}${testRes.balance || 'N/A'}</b>\n⏱ Roundtrip Latency: <b>${testRes.latency}ms</b>`, { parse_mode: 'HTML' });
                            } else {
                                throw new Error(testRes.error);
                            }
                        } catch (err) {
                            return ctx.reply(`❌ <b>Provider Health Check Failed:</b> ${err.message}`, { parse_mode: 'HTML' });
                        }
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prov_test_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_prov_del_')) {
                processed = true;
                try {
                    const provId = data.replace('adm_prov_del_', '');
                    const res = providerService.deleteProvider(provId);
                    if (res.success) {
                        return await adminHandler.renderProvidersAdmin(ctx);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_prov_del_ failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- User edits ---
            if (data.startsWith('adm_u_addbal_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_addbal_', '');
                    ctx.session.editTargetUserId = target;
                    ctx.session.step = 'ADM_U_ADDBAL';
                    return ctx.reply(`➕ Enter balance to ADD to User ID ${target}:`);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_addbal_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_dedbal_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_dedbal_', '');
                    ctx.session.editTargetUserId = target;
                    ctx.session.step = 'ADM_U_DEDBAL';
                    return ctx.reply(`➖ Enter balance to DEDUCT from User ID ${target}:`);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_dedbal_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_ban_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_ban_', '');
                    settings.banned_users = settings.banned_users || [];
                    if (!settings.banned_users.includes(target)) {
                        settings.banned_users.push(target);
                        db.saveDb('settings.json', settings);
                    }
                    logger.info('BAN_USER', `Banned target account ID: ${target}`, config.ADMIN_ID);
                    return await adminHandler.renderUserEditPanel(ctx, target);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_ban_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_unban_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_unban_', '');
                    settings.banned_users = settings.banned_users || [];
                    settings.banned_users = settings.banned_users.filter(id => id !== target);
                    db.saveDb('settings.json', settings);
                    logger.info('UNBAN_USER', `Unbanned target account ID: ${target}`, config.ADMIN_ID);
                    return await adminHandler.renderUserEditPanel(ctx, target);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_unban_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_role_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_role_', '');
                    const users = db.loadDb('users.json');
                    if (users[target]) {
                        const newRole = users[target].role === 'Admin' ? 'User' : 'Admin';
                        users[target].role = newRole;
                        db.saveDb('users.json', users);
                        
                        if (newRole === 'Admin') {
                            if (!settings.admins) settings.admins = [];
                            if (!settings.admins.includes(target)) settings.admins.push(target);
                        } else {
                            if (settings.admins) settings.admins = settings.admins.filter(id => id !== target);
                        }
                        db.saveDb('settings.json', settings);

                        return await adminHandler.renderUserEditPanel(ctx, target);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_role_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_reset_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_reset_', '');
                    const wallets = db.loadDb('wallet.json');
                    if (wallets[target]) {
                        wallets[target].balance = 0.0;
                        wallets[target].history.push({
                            type: 'RESET',
                            amount: 0,
                            timestamp: new Date().toISOString(),
                            description: 'Wallet reset executed.'
                        });
                        db.saveDb('wallet.json', wallets);
                        return await adminHandler.renderUserEditPanel(ctx, target);
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_reset_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_pm_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_pm_', '');
                    ctx.session.editTargetUserId = target;
                    ctx.session.step = 'ADM_U_PM';
                    return ctx.reply(`✉ Enter personal notification message to deliver to User ID ${target}:`);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_pm_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('adm_u_delete_')) {
                processed = true;
                try {
                    const target = data.replace('adm_u_delete_', '');
                    const users = db.loadDb('users.json');
                    if (users[target]) {
                        delete users[target];
                        db.saveDb('users.json', users);
                        return ctx.reply('✅ User account completely wiped.');
                    }
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `adm_u_delete_ failed: ${err.message}`, ctx.from.id);
                }
            }
        }
   

if (data.startsWith('adm_user_view_')) {
    processed = true;

    try {

        const targetId =
            data.replace(
                'adm_user_view_',
                ''
            );

        return adminHandler.renderUserEditPanel(
            ctx,
            targetId
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_user_view_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}
if (data.startsWith('adm_actions_')) {

    processed = true;

    try {

        const targetId =
            data.replace(
                'adm_actions_',
                ''
            );

        return ctx.editMessageReplyMarkup({
            inline_keyboard: [

                [
                    {
                        text: '➕ Add Balance',
                        callback_data: `adm_u_addbal_${targetId}`
                    },
                    {
                        text: '➖ Deduct Balance',
                        callback_data: `adm_u_dedbal_${targetId}`
                    }
                ],

                [
                    {
                        text: '🚫 Ban User',
                        callback_data: `adm_u_ban_${targetId}`
                    },
                    {
                        text: '🛠 Admin Role',
                        callback_data: `adm_u_role_${targetId}`
                    }
                ],

                [
                    {
                        text: '💳 Reset Wallet',
                        callback_data: `adm_u_reset_${targetId}`
                    },
                    {
                        text: '✉ PM User',
                        callback_data: `adm_u_pm_${targetId}`
                    }
                ],

                [
                    {
                        text: '🗑 Delete User',
                        callback_data: `adm_u_delete_${targetId}`
                    }
                ],

                [
                    {
                        text: '⬅️ Back',
                        callback_data: `adm_user_view_${targetId}`
                    }
                ]

            ]
        });

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_actions_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}
if (data.startsWith('adm_wallet_')) {

    processed = true;

    try {

        const targetId =
            data.replace(
                'adm_wallet_',
                ''
            );

        const wallets =
            db.loadDb('wallet.json') || {};

        const wallet =
            wallets[targetId] || {
                balance: 0,
                history: []
            };

        let txt =
`📜 WALLET HISTORY

👤 User ID: ${targetId}
💰 Balance: ₹${wallet.balance}

────────────────`;

        if (
            wallet.history &&
            wallet.history.length > 0
        ) {

            wallet.history
                .slice(-10)
                .reverse()
                .forEach(h => {

                    txt +=
`\n\n${h.type}
₹${h.amount}
${h.timestamp}`;

                });

        } else {

            txt +=
`\n\nNo transaction history found`;

        }

        return ctx.editMessageText(
            txt,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                `adm_user_view_${targetId}`
                            }
                        ]
                    ]
                }
            }
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_wallet_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}
if (data.startsWith('adm_deposits_')) {

    processed = true;

    try {

        const targetId =
            data.replace(
                'adm_deposits_',
                ''
            );

        const wallets =
            db.loadDb('wallet.json') || {};

        const wallet =
            wallets[targetId] || {
                history: []
            };

        let txt =
`📥 DEPOSIT HISTORY

👤 User ID: ${targetId}

────────────────`;

        const deposits =
            (wallet.history || [])
            .filter(
                h => h.type === 'RECHARGE_CREDIT'
            );

        if (deposits.length > 0) {

            deposits
                .reverse()
                .forEach(d => {

                    txt +=
`\n\n💰 ₹${d.amount}
🕒 ${d.timestamp}
📝 ${d.description || '-'}`;

                });

        } else {

            txt +=
`\n\nNo deposit history found`;

        }

        return ctx.editMessageText(
            txt,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                `adm_user_view_${targetId}`
                            }
                        ]
                    ]
                }
            }
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_deposits_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}
if (data.startsWith('adm_withdraws_')) {

    processed = true;

    try {

        const targetId =
            data.replace('adm_withdraws_', '');

        const wallets =
            db.loadDb('wallet.json') || {};

        const wallet =
            wallets[targetId] || { history: [] };

        let txt =
`📤 WITHDRAWAL HISTORY

👤 User ID: ${targetId}

────────────────`;

        const withdraws =
            (wallet.history || [])
            .filter(
                h => h.type === 'WITHDRAWAL_PAID'
            );

        if (withdraws.length > 0) {

            withdraws.reverse().forEach(w => {

                txt +=
`\n\n💸 ₹${w.amount}
🕒 ${w.timestamp}
📝 ${w.description || '-'}`;

            });

        } else {

            txt += '\n\nNo withdrawal history found';

        }

        return ctx.editMessageText(
            txt,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                `adm_user_view_${targetId}`
                            }
                        ]
                    ]
                }
            }
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_withdraws_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}

if (data.startsWith('adm_refs_')) {

    processed = true;

    try {

        const targetId =
            data.replace('adm_refs_', '');

        const refs =
            db.loadDb('referrals.json') || {};

        const userRef =
            refs[targetId] || {
                referredUsers: [],
                earnings: {
                    total: 0
                }
            };

        let txt =
`🎁 REFERRAL HISTORY

👤 User ID: ${targetId}

💰 Total Earned: ₹${userRef.earnings.total}

────────────────`;

        if (
            userRef.referredUsers.length
        ) {

            userRef.referredUsers.forEach(r => {

                txt +=
`\n\n🆔 ${r.userId}
📌 ${r.status}
💰 ₹${r.earned}`;

            });

        } else {

            txt +=
'\n\nNo referrals found';

        }

        return ctx.editMessageText(
            txt,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                `adm_user_view_${targetId}`
                            }
                        ]
                    ]
                }
            }
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_refs_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}
if (data.startsWith('adm_orders_')) {

    processed = true;

    try {

        const targetId =
            data.replace(
                'adm_orders_',
                ''
            );

        const orders =
            db.loadDb('orders.json') || [];

        const userOrders =
            orders.filter(
                o => o.userId === targetId
            );

        let txt =
`📦 ORDER HISTORY

👤 User ID: ${targetId}

────────────────`;

        if (userOrders.length > 0) {

            userOrders
                .slice(-15)
                .reverse()
                .forEach(o => {

                    txt +=
`\n\n📱 ${o.productName || 'Unknown'}
💰 ₹${o.price || 0}
📌 ${o.status || 'UNKNOWN'}
🕒 ${o.createdAt || o.timestamp || '-'}`;

                });

        } else {

            txt +=
`\n\nNo orders found`;

        }

        return ctx.editMessageText(
            txt,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                `adm_user_view_${targetId}`
                            }
                        ]
                    ]
                }
            }
        );

    } catch (err) {

        logger.error(
            'CALLBACK_ERROR',
            `adm_orders_ failed: ${err.message}`,
            ctx.from.id
        );

    }
}

// ==========================================
        // USER CALLBACK SYSTEM
        // ==========================================
       
 if (!processed) {
            if (data === 'fj_verify') {
                processed = true;

                const forcejoin = db.loadDb('forcejoin.json') || {
                    enabled: true,
                    channels: []
                };

                let allJoined = true;

                    for (const ch of forcejoin.channels) {

                    if (ch.type === 'public') {

                        try {
              
const member = await ctx.telegram.getChatMember(
    ch.username,
    ctx.from.id
);


            console.log(
                'VERIFY:',
                ch.username,
                ctx.from.id
            );
                            if (
                                member.status === 'left' ||
                                member.status === 'kicked'
                            ) {
                                allJoined = false;
                                break;
                            }

              } catch (e) {
                console.log('VERIFY ERROR:', e.message);
                allJoined = false;
                break;
            }
                        }
                    

if (ch.type === 'private') {

    try {

        const member = await ctx.telegram.getChatMember(
            ch.channelId,
            ctx.from.id
        );

        console.log(
            'PRIVATE VERIFY:',
            ch.channelId,
            member.status
        );

        if (
            member.status === 'left' ||
            member.status === 'kicked'
        ) {
            allJoined = false;
            break;
        }

    } catch (e) {

        console.log(
            'PRIVATE VERIFY ERROR:',
            e.message
        );

        allJoined = false;
        break;
    }
}
}

                if (!allJoined) {
                    return ctx.reply(
                        '❌ Please join all required channels first.'
                    );
                }
const payload = ctx.session.refPayload;
console.log('SESSION REF PAYLOAD:', ctx.session.refPayload);

if (payload && payload.startsWith('ref_')) {

    const referrerId = payload.replace('ref_', '');
    const userId = ctx.from.id.toString();

    if (referrerId !== userId) {

        const referrals = db.loadDb('referrals.json') || {};

        if (!referrals[referrerId]) {
            referrals[referrerId] = {
                referredUsers: [],
                earnings: {
                    total: 0,
                    pending: 0,
                    paid: 0
                }
            };
        }

        const exists = referrals[referrerId].referredUsers.some(
            u => u.userId === userId
        );

        if (!exists) {
            referrals[referrerId].referredUsers.push({
                userId,
                status: 'REGISTERED',
                earned: 0
            });

            db.saveDb('referrals.json', referrals);

            console.log(
                'FORCEJOIN REFERRAL REGISTERED:',
                referrerId,
                '->',
                userId
            );
        }
    }

    delete ctx.session.refPayload;
}


                return userHandler.handleStart(ctx);
            }
}


        if (!processed) {
            if (data === 'wallet_deposit_init') {
                processed = true;
                try {
                    return await walletHandler.handleDepositInit(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `wallet_deposit_init failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data === 'wallet_withdraw_init') {
                processed = true;
                try {
                    return await walletHandler.handleWithdrawInit(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `wallet_withdraw_init failed: ${err.message}`, ctx.from.id);
                }

            }

if (data === 'wallet_history') {
    processed = true;

    try {
        return userHandler.renderTransactionHistory(ctx);
    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `wallet_history failed: ${err.message}`,
            ctx.from.id
        );
    }
}


if (data === 'ref_share') {
    processed = true;

    const inviteLink =
        `https://t.me/${ctx.botInfo.username}?start=ref_${ctx.from.id}`;

    const shareText =
`🎁 Get Virtual Numbers Instantly

📱 Buy virtual numbers for OTP verification across popular services.

💰 Earn referral rewards when your invited users make successful deposits.

🔗 ${inviteLink}`;

    return ctx.reply(shareText);
}
if (data === 'ref_leaderboard') {
    processed = true;

    const referrals = db.loadDb('referrals.json') || {};

    const top = Object.keys(referrals)
        .map(id => ({
            id,
            earned: referrals[id].earnings?.total || 0
        }))
        .sort((a, b) => b.earned - a.earned)
        .slice(0, 10);

    let txt = '🏆 <b>TOP REFERRERS</b>\n\n';

    top.forEach((u, i) => {
        const medal =
            i === 0 ? '🥇' :
            i === 1 ? '🥈' :
            i === 2 ? '🥉' :
            `${i + 1}.`;

        txt += `${medal} <code>${u.id}</code> — <b>₹${u.earned.toFixed(2)}</b>\n`;
    });

    txt += '\n━━━━━━━━━━━━━━\n🎁 Invite friends and earn referral rewards.';

    return ctx.reply(txt, {
        parse_mode: 'HTML'
    });
}

            if (data === 'user_main_menu') {
                processed = true;
                try {
                    const welcome = `👋 <b>Welcome back to ${settings.bot_name}</b>\n─────────────────────────\n🚀 Select a transaction option from the main keyboard below to continue.`;
                    return ctx.reply(welcome, { parse_mode: 'HTML', reply_markup: userHandler.getMainMenu(ctx.from.id) });
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_main_menu failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_profile') {
                processed = true;
                try {
                    return userHandler.handleProfile(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_profile failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_wallet') {
                processed = true;
                try {
                    return walletHandler.renderWalletMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_wallet failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_referral') {
                processed = true;
                try {
                    return referralHandler.renderReferralMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_referral failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_settings') {
                processed = true;
                try {
                    return handleSettings(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_settings failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_support') {
                processed = true;
                try {
                    return userHandler.handleSupport(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_support failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_hist') {
                processed = true;
                try {
                    return userHandler.renderTransactionHistory(ctx, 0);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_hist failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_orders') {
                processed = true;
                try {
                    const orders = db.loadDb('orders.json').filter(o => o.userId === ctx.from.id.toString() && o.status === 'WAITING');
                    if (orders.length === 0) return ctx.reply('ℹ️ You have no active waiting orders.');
                    orders.forEach(o => {
                        ctx.reply(`📞 <b>${o.productName}</b> - <code>${o.number}</code> (Pending OTP)`, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Pull OTP', callback_data: `order_check_${o.id}` }],
                                    [{ text: '❌ Cancel & Refund', callback_data: `order_cancel_${o.id}` }]
                                ]
                            }
                        });
                    });
                    return;
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_orders failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data.startsWith('user_hist_page_')) {
                processed = true;
                try {
                    const page = parseInt(data.replace('user_hist_page_', ''), 10);
                    return userHandler.renderTransactionHistory(ctx, isNaN(page) ? 0 : page);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_hist_page_ failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_support_faq') {
                processed = true;
                try {
                    const faq = `❓ <b>FAQ & KNOWLEDGE BASE</b>\n─────────────────────────\n` +
                        `<b>Q: How fast are SMS codes delivered?</b>\n` +
                        `A: Usually within 10 to 30 seconds depending on service traffic.\n\n` +
                        `<b>Q: What happens if my line times out?</b>\n` +
                        `A: If no SMS code is delivered within the timeout window, the transaction rolls back and refunds your balance automatically.\n\n` +
                        `<b>Q: Can I reuse a phone number?</b>\n` +
                        `A: All phone numbers are transient virtual sessions and can only be used once.`;
                    return ctx.reply(faq, { parse_mode: 'HTML' });
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_support_faq failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_support_report') {
                processed = true;
                try {
                    return ctx.reply(`🚨 <b>Report an Issue</b>\n─────────────────────────\nPlease send full details and logs of your problem directly to: <b>@${settings.support_username}</b>`, { parse_mode: 'HTML' });
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_support_report failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_set_lang') {
                processed = true;
                try {
                    return await handleSetLanguage(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_set_lang failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_set_notify') {
                processed = true;
                try {
                    return await handleSetNotifications(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_set_notify failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'user_set_theme') {
                processed = true;
                try {
                    return await handleSetTheme(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `user_set_theme failed: ${err.message}`, ctx.from.id);
                }
            }

            // --- SMS PROCESS FLOW ROUTING ---
            if (data.startsWith('buy_prod_')) {
                processed = true;
                try {
                    const prodId = data.replace('buy_prod_', '');
                    return orderHandler.renderProductDetails(ctx, prodId);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_prod_ failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('confirm_buy_')) {
                processed = true;
                try {
                    const prodId = data.replace('confirm_buy_', '');
                    return orderHandler.handleBuyProduct(ctx, prodId);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `confirm_buy_ failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('order_check_')) {
                processed = true;
                try {
                    const orderId = data.replace('order_check_', '');
                    return orderHandler.handleCheckOTP(ctx, orderId);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `order_check_ failed: ${err.message}`, ctx.from.id);
                }
            }

            if (data.startsWith('order_cancel_')) {
                processed = true;
                try {
                    const orderId = data.replace('order_cancel_', '');
                    return orderHandler.forceRollbackRefund(orderId, ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `order_cancel_ failed: ${err.message}`, ctx.from.id);
                }
            }

            // ===== ENTERPRISE BUY MENU CALLBACKS =====
            if (data === 'buy_popular') {
                processed = true;
                try {
                    return orderHandler.renderPopularMenu(ctx);
    
  } catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_popular failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'buy_categories') {
                processed = true;
                try {
                    return orderHandler.renderCategoryMenu(ctx);
} catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_categories failed: ${err.message}`, ctx.from.id);
                }
            }
if (data.startsWith('fav_add_')) {
    processed = true;

    try {
        const productId = data.replace('fav_add_', '');
        const userId = String(ctx.from.id);

        const favorites = db.loadDb('favorites.json') || {};

        if (!favorites[userId]) {
            favorites[userId] = [];
        }

        if (!favorites[userId].includes(productId)) {
            favorites[userId].push(productId);
            db.saveDb('favorites.json', favorites);
            await ctx.answerCbQuery('⭐ Added to Favorites');
        } else {
            await ctx.answerCbQuery('⭐ Already in Favorites');
        }

        return orderHandler.renderProductDetails(ctx, productId);

    } catch (err) {
        logger.error('CALLBACK_ERROR', `fav_add failed: ${err.message}`, ctx.from.id);
    }
}
if (data.startsWith('fav_remove_')) {
    processed = true;

    try {
        const productId = data.replace('fav_remove_', '');
        const userId = String(ctx.from.id);

        const favorites = db.loadDb('favorites.json') || {};

        if (!favorites[userId]) {
            favorites[userId] = [];
        }

        favorites[userId] = favorites[userId].filter(
            id => String(id) !== String(productId)
        );

        db.saveDb('favorites.json', favorites);

        await ctx.answerCbQuery('❌ Removed from Favorites');

        return orderHandler.renderProductDetails(ctx, productId);

    } catch (err) {
        logger.error(
            'CALLBACK_ERROR',
            `fav_remove failed: ${err.message}`,
            ctx.from.id
        );
    }
}

            if (data === 'buy_menu') {
    processed = true;
    try {
        await ctx.answerCbQuery().catch(() => {});
        return await orderHandler.renderBuyMenu(ctx);
    } catch (err) {
        logger.error('CALLBACK_ERROR', `buy_menu failed: ${err.message}`, ctx.from.id);
    }
}
            if (data === 'buy_search') {
                processed = true;
                try {
                    ctx.session.step = 'USER_PRODUCT_SEARCH';
                    ctx.session.searchPage = 1;
                    return orderHandler.renderSearchMenu(ctx);
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_search failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'buy_recent') {
                processed = true;
                try {
                    return orderHandler.renderRecentMenu(ctx);
   
                } catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_recent failed: ${err.message}`, ctx.from.id);
                }
            }
            if (data === 'buy_favorites') {
                processed = true;
                try {
                    return orderHandler.renderFavoritesMenu(ctx);

                } catch (err) {
                    logger.error('CALLBACK_ERROR', `buy_favorites failed: ${err.message}`, ctx.from.id);
                }
            }

            // ===== USER CATEGORY DYNAMIC FLOW =====
            if (data.startsWith('cat_') && !data.startsWith('cat_add_')) {
                processed = true;
                try {
                    const category = data.replace('cat_', '').replace(/_/g, ' ');
                    return orderHandler.renderCategoryProducts(ctx, category);

              } catch (err) {
                    logger.error('CALLBACK_ERROR', `dynamic category failed: ${err.message}`, ctx.from.id);
                }
            }
        }

// Unknown Callback Protection
if (!processed) {
    await ctx.answerCbQuery('Unknown action').catch(() => {});
}
} catch (err) {
    logger.error(
        'ERROR',
        `Callback Query dispatcher crashed: ${err.message}`,
        ctx.from?.id
    );

    if (!processed) {
        try {
            await ctx.answerCbQuery(
                'Error processing request'
            ).catch(() => {});
        } catch (e) {}
    }
}
});
// ==========================================
// SCENE ACTION INPUT PROCESSING ENGINE
// ==========================================
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.session || (!ctx.session.step && !ctx.session.adminState)) return next();
        const settings = db.loadDb('settings.json');
        const isAdmin = (ctx.from.id === config.ADMIN_ID || (settings.admins && settings.admins.includes(ctx.from.id.toString())));

        if (isAdmin) {
            // Unify administrator text-state routing
            const handledByAdmin = await adminHandler.handleAdminTextInput(ctx);
            if (handledByAdmin) return;
        }

        // Fallback user state processing
  const step = ctx.session.step;
        const text = ctx.message.text ? ctx.message.text.trim() : null;

// =========================
// FORCE JOIN PUBLIC
// =========================
if (step === 'FJ_PUBLIC_USERNAME' && text) {
    const forcejoin = db.loadDb('forcejoin.json') || {
        enabled: true,
        channels: []
    };

    forcejoin.channels.push({
        type: 'public',
        username: text.startsWith('@') ? text : '@' + text
    });

    db.saveDb('forcejoin.json', forcejoin);

    ctx.session.step = null;

    return ctx.reply(`✅ Public channel added:\n${text}`);
}

// =========================
// FORCE JOIN PRIVATE ID
// =========================
if (step === 'FJ_PRIVATE_ID' && text) {
    ctx.session.privateChannelId = text;
    ctx.session.step = 'FJ_PRIVATE_LINK';

    return ctx.reply(
        '🔗 Send Invite Link\n\nExample:\nhttps://t.me/+xxxxx'
    );
}

// =========================
// FORCE JOIN PRIVATE LINK
// =========================
if (step === 'FJ_PRIVATE_LINK' && text) {
    const forcejoin = db.loadDb('forcejoin.json') || {
        enabled: true,
        channels: []
    };

    forcejoin.channels.push({
        type: 'private',
        channelId: ctx.session.privateChannelId,
        inviteLink: text
    });

    db.saveDb('forcejoin.json', forcejoin);

    delete ctx.session.privateChannelId;
    ctx.session.step = null;

    return ctx.reply('✅ Private channel added successfully.');
}
// =========================
// PRODUCT ADD WIZARD
// =========================

if (step === 'ADM_PROD_ADD_NAME' && text) {
    ctx.session.newProduct = ctx.session.newProduct || {};
    ctx.session.newProduct.name = text;

    ctx.session.step = 'ADM_PROD_ADD_EMOJI';

    return adminHandler.renderWizardStep(
        ctx,
        4,
        '😀 Enter Product Emoji (Example: 📱, 💬, ✈️):',
        'adm_prod_back_step2'
    );
}

if (step === 'ADM_PROD_ADD_EMOJI' && text) {
    ctx.session.newProduct.emoji = text;
    ctx.session.newProduct.manualPrice = null;
    ctx.session.step = 'ADM_PROD_ADD_DESC';

    return adminHandler.renderWizardStep(
        ctx,
        5,
        '📝 Enter Product Description:',
        'adm_prod_back_step3'
    );
}

if (step === 'ADM_PROD_ADD_DESC' && text) {

    ctx.session.newProduct.description = text;

    ctx.session.step = 'ADM_PROD_ADD_CODE';

    return adminHandler.renderWizardStep(
        ctx,
        6,
        '🔑 Enter Provider Service Code:',
        'adm_prod_back_step3'
    );
}
// ==========================================
// PRODUCT DESCRIPTION EDIT
// ==========================================

if (step === 'ADM_PROD_EDIT_DESC' && text) {

    const products = db.loadDb('products.json');

    const idx = products.findIndex(
        p => p.id === ctx.session.editProdId
    );

    if (idx === -1) {
        ctx.session.step = null;
        return ctx.reply('❌ Product not found.');
    }

    products[idx].description = text;

    db.saveDb('products.json', products);

    ctx.session.step = null;
    ctx.session.editProdId = null;

    return ctx.reply('✅ Product description updated.');
}
if (step === 'ADM_PROD_EDIT_DESC' && text) {

    const products = db.loadDb('products.json');
    const product = products.find(p => p.id === ctx.session.editProdId);

    if (!product) {
        ctx.session.step = null;
        ctx.session.editProdId = null;
        return ctx.reply('❌ Product not found.');
    }

    product.description = text;

    db.saveDb('products.json', products);

    ctx.session.step = null;
    ctx.session.editProdId = null;

    return ctx.reply('✅ Product description updated successfully.');
}
if (step === 'ADM_PROD_ADD_CODE' && text) {

    ctx.session.newProduct.code = text;

    return adminHandler.renderProductConfirm(
        ctx,
        ctx.session.newProduct
    );
}


        if (step === 'W_DEPOSIT_AMT' && text) {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < settings.min_recharge || amount > settings.max_recharge) {
                return ctx.reply(`❌ Invalid amount. Recharge limit is ${settings.currency}${settings.min_recharge} - ${settings.currency}${settings.max_recharge}. Enter again:`);
            }
            ctx.session.depositAmount = amount;
            ctx.session.step = 'W_DEPOSIT_UTR';
if (settings.qr_file) {

    return ctx.replyWithPhoto(
        settings.qr_file,
        {
            caption:
`💳 <b>UPI Deposit Request: ${settings.currency}${amount.toFixed(2)}</b>
─────────────────────────

🏦 UPI ID:
<code>${settings.upi_id}</code>

📸 Scan the QR code and make payment.

🔍 Send your UTR number to verify this payment:`,

            parse_mode: 'HTML'
        }
    );

}

return ctx.reply(
`💳 <b>UPI Deposit Request: ${settings.currency}${amount.toFixed(2)}</b>
─────────────────────────

🏦 UPI ID:
<code>${settings.upi_id}</code>

Once completed, reply with your 12-digit UPI UTR transaction reference code:`,
{
    parse_mode: 'HTML'
}
);
        }

        if (step === 'W_DEPOSIT_UTR' && text) {
            if (text.length < 10) return ctx.reply('❌ Invalid UTR size. Please submit a valid transaction reference code:');
            if (walletHandler.isUtrDuplicate(text)) {
                return ctx.reply('❌ <b>Security Block:</b> This transaction UTR has already been submitted or cleared.', { parse_mode: 'HTML' });
            }

            ctx.session.rechargeUtr = text;
            ctx.session.step = 'W_DEPOSIT_SCREENSHOT';
            return ctx.reply('📸 Almost completed. Upload and send a clear screenshot of your transaction confirmation:');
        }

        if (step === 'W_WITHDRAW_AMT' && text) {

    const amount = parseFloat(text);

    const referrals =
        db.loadDb('referrals.json') || {};

    const refData =
        referrals[ctx.from.id.toString()] || {
            earnings: {
                total: 0
            }
        };

    const referralBalance =
        Number(refData.earnings?.total || 0);

    if (isNaN(amount) || amount < 20) {
        return ctx.reply(
            '❌ Minimum withdrawal amount is ₹20.'
        );
    }

    if (amount > referralBalance) {
        return ctx.reply(
            `❌ Available referral balance: ₹${referralBalance}`
        );
    }

    ctx.session.withdrawAmount = amount;
    ctx.session.step = 'W_WITHDRAW_DETAILS';

    return ctx.reply(
        '⚙ Enter your UPI ID:'
    );
}

        if (step === 'W_WITHDRAW_DETAILS' && text) {
const referrals =
    db.loadDb('referrals.json') || {};

const refData =
    referrals[ctx.from.id.toString()] || {
        earnings: {
            total: 0
        }
    };

if (
    refData.earnings.total <
    ctx.session.withdrawAmount
) {
    ctx.session.step = null;

    return ctx.reply(
        '❌ Insufficient referral balance.'
    );
}
if (!refData.earnings) {
    refData.earnings = {
        total: 0,
        pending: 0,
        paid: 0
    };
}

refData.earnings.total -=
    ctx.session.withdrawAmount;

refData.earnings.pending +=
    ctx.session.withdrawAmount;

referrals[ctx.from.id.toString()] =
    refData;

db.saveDb(
    'referrals.json',
    referrals
);
const wallets = db.loadDb('wallet.json');
const userWallet = wallets[ctx.from.id.toString()];

if (userWallet) {
    userWallet.balance = Math.max(
        0,
        userWallet.balance - ctx.session.withdrawAmount
    );

    wallets[ctx.from.id.toString()] = userWallet;
    db.saveDb('wallet.json', wallets);
}


            const currentPending = settings.pending_withdrawals || [];
            const reqId = 'wtd_' + Math.random().toString(36).substring(2, 9);
            currentPending.push({
                id: reqId,
                userId: ctx.from.id.toString(),
                amount: ctx.session.withdrawAmount,
                details: text,
                timestamp: new Date().toISOString()
            });
            settings.pending_withdrawals = currentPending;
            db.saveDb('settings.json', settings);

            ctx.session.step = null;
            ctx.reply('✅ Withdrawal request received and queued. Funds were temporary locked during payout validation.', userHandler.getMainMenu(ctx.from.id));

            bot.telegram.sendMessage(config.ADMIN_ID, `📤 <b>NEW WITHDRAWAL ALERT</b>\n─────────────────────────\n👤 User ID: <code>${ctx.from.id}</code>\n💰 Amount: <b>${settings.currency}${ctx.session.withdrawAmount.toFixed(2)}</b>\n📝 Details: <code>${text}</code>\n\nConfirm completed payouts inside: <b>Withdrawals Queue</b>`, { parse_mode: 'HTML' }).catch(() => {});
            return;
        }

    } catch (err) {
        logger.error('ERROR', `Input message dispatcher failed: ${err.message}`, ctx.from?.id);
    }
    return next();
});

// Photo upload (recharge proof) processor
bot.on('photo', async (ctx) => {
    try {
if (
    ctx.session &&
    ctx.session.step === 'ADM_CFG_QR'
) {

    const photo =
        ctx.message.photo[
            ctx.message.photo.length - 1
        ];

    const settings =
        db.loadDb('settings.json');

    settings.qr_file =
        photo.file_id;

    db.saveDb(
        'settings.json',
        settings
    );

    ctx.session.step = null;

    return ctx.reply(
        '✅ QR Code Saved Successfully'
    );
}
        if (!ctx.session || ctx.session.step !== 'W_DEPOSIT_SCREENSHOT') return;

        const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution
        const fileId = photo.file_id;
        const amount = ctx.session.depositAmount;
        const utr = ctx.session.rechargeUtr;
        const userId = ctx.from.id.toString();
        const settings = db.loadDb('settings.json');

        const currentPending = settings.pending_payments || [];
        const reqId = 'req_' + Math.random().toString(36).substring(2, 9);
        currentPending.push({
            id: reqId,
            userId,
            amount,
            utr,
            fileId,
            timestamp: new Date().toISOString()
        });
        settings.pending_payments = currentPending;
        db.saveDb('settings.json', settings);

        ctx.session.step = null;
        ctx.reply('✅ Payment verification documents received. Manual confirmation is pending review.', userHandler.getMainMenu(ctx.from.id));

        bot.telegram.sendPhoto(config.ADMIN_ID, fileId, {
            caption: `📥 <b>NEW DEPOSIT REQUEST ALERT</b>\n─────────────────────────\n👤 User ID: <code>${userId}</code>\n💰 Amount: <b>${settings.currency}${amount.toFixed(2)}</b>\n📝 Reference Code: <code>${utr}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Approve', callback_data: `adm_pay_app_${reqId}` },
                        { text: '❌ Reject', callback_data: `adm_pay_rej_${reqId}` }
                    ]
                ]
            }
        }).catch(() => {});

    } catch (err) {
        logger.error('ERROR', `Photo payload processing failed: ${err.message}`, ctx.from?.id);
    }
});

// ==========================================
// BACKGROUND ORCHESTRATION RECOVERY DAEMON
// ==========================================
async function backgroundRecoveryDaemon() {
    try {
        const orders = db.loadDb('orders.json');
        const wallets = db.loadDb('wallet.json');
        const settings = db.loadDb('settings.json');
        const now = Date.now();
        let stateModified = false;

        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            if (order.status === 'WAITING' && (now - order.timestamp > (settings.order_timeout * 1000))) {
                order.status = 'CANCELLED';
                orders[i] = order;

                try {
                    await providerService.setStatus(order.providerSysId, order.providerOrderId, '8').catch(() => {});
                } catch (e) {}

                const uWallet = wallets[order.userId];
                if (uWallet) {
                    uWallet.balance += order.price;
                    uWallet.history.push({
                        type: 'AUTO_REFUND',
                        amount: order.price,
                        timestamp: new Date().toISOString(),
                        description: `Recovery rollback refund for timed out order #${order.id}`
                    });
                    wallets[order.userId] = uWallet;
                }
                stateModified = true;
                logger.info('RECOVERY_DAEMON', `Auto-refunded expired order #${order.id} for user ${order.userId}`);
            }
        }

        if (stateModified) {
            db.saveDb('orders.json', orders);
            db.saveDb('wallet.json', wallets);
        }
    } catch (err) {
        // Prevent background loop error crashes
    }
}
// Start auto-cleanup recovery loop every 15 seconds
setInterval(backgroundRecoveryDaemon, 15000);

// ==========================================
// GRACEFUL SYSTEM SHUTDOWN PROCEDURES
// ==========================================
function gracefulShutdown(signal) {
    logger.info('BOT_STOPPED', `Shutting down bot process due to signal: ${signal}`);
    
    // Clear lock file to release directory resources
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
    } catch (_) {}

    bot.stop(signal);
    process.exit(0);
}

bot.on('text', async (ctx, next) => {
    if (!ctx.session) ctx.session = {};

    const text = ctx.message.text.trim();

    // FORCE JOIN PUBLIC
    if (ctx.session.step === 'FJ_PUBLIC_USERNAME') {
        const forcejoin = db.loadDb('forcejoin.json') || {
            enabled: true,
            channels: []
        };

        forcejoin.channels.push({
            type: 'public',
            username: text.startsWith('@') ? text : '@' + text
        });

        db.saveDb('forcejoin.json', forcejoin);

        ctx.session.step = null;

        return ctx.reply(`✅ Public channel added:\n${text}`);
    }

    // FORCE JOIN PRIVATE ID
    if (ctx.session.step === 'FJ_PRIVATE_ID') {
        ctx.session.privateChannelId = text;
        ctx.session.step = 'FJ_PRIVATE_LINK';

        return ctx.reply(
            '🔗 Send Invite Link\n\nExample:\nhttps://t.me/+xxxxx'
        );
    }

    // FORCE JOIN PRIVATE LINK
    if (ctx.session.step === 'FJ_PRIVATE_LINK') {
        const forcejoin = db.loadDb('forcejoin.json') || {
            enabled: true,
            channels: []
        };

        forcejoin.channels.push({
            type: 'private',
            channelId: ctx.session.privateChannelId,
            inviteLink: text
        });

        db.saveDb('forcejoin.json', forcejoin);

        ctx.session.step = null;
        delete ctx.session.privateChannelId;

        return ctx.reply('✅ Private channel added successfully.');
    }

if (ctx.session.step === 'USER_PRODUCT_SEARCH') {
    return orderHandler.handleSearchInput(ctx);
}

return next();
});
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ==========================================
// CLIENT LAUNCH ENCRYPTED ENGINE
// ==========================================
bot.launch()
    .then(() => {
        logger.info('BOT_STARTED', 'Enterprise SMS Bot client launched successfully.');
        console.log('🤖 Enterprise Telegram Activation Client active.');
    })
    .catch((err) => {
        logger.error('ERROR', `Fatal launch error on Telegraf boot: ${err.message}`);
    });
                   
