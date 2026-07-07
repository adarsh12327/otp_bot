const { loadDb, saveDb, DB_DIR } = require('../utils/database');
const providerService = require('../services/providerService');
const logger = require('../utils/logger');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * Safe message editor.
 * Gracefully downgrades to message replies if editing triggers Telegram state mismatches.
 */
async function safeEdit(ctx, text, extra = {}) {
    try {
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            return await ctx.editMessageText(text, extra);
        } else {
            return await ctx.reply(text, extra);
        }
    } catch (err) {
        try {
            return await ctx.reply(text, extra);
        } catch (replyErr) {
            logger.error('TELEGRAM_ERROR', `Failed safeEdit in admin.js: ${replyErr.message}`, ctx.from?.id);
        }
    }
}
function getCalculatedPrice(providerCost) {
    const settings = loadDb('settings.json');

    const usdToInr = Number(settings.usd_to_inr || 105);
    const profit = Number(settings.profit_percent || 10);

    const costInINR = Number(providerCost) * usdToInr;
    const finalCost = costInINR * (1 + profit / 100);

    return Number(finalCost.toFixed(2));
}
// ==========================================
// 🏠 MAIN ADMIN DASHBOARD & STATS (REMAPS)
// ==========================================
function renderAdminMenu(ctx) {
    try {
        const users = loadDb('users.json');
        const orders = loadDb('orders.json');
        const wallets = loadDb('wallet.json');
        const settings = loadDb('settings.json');

        const totalUsers = Object.keys(users).length;
        const activeUsersCount = Object.values(users).filter(u => u.role !== 'Banned').length;
        const totalOrders = orders.length;

        let completedOrders = 0;
        let cancelledOrders = 0;
        let pendingOrders = 0;
        let totalRevenue = 0;
        let totalDeposits = 0;
        let totalWithdraws = 0;

        orders.forEach(o => {
            if (o.status === 'COMPLETED') {
                completedOrders++;
                totalRevenue += o.price;
            } else if (o.status === 'CANCELLED') {
                cancelledOrders++;
            } else if (o.status === 'WAITING') {
                pendingOrders++;
            }
        });

        Object.values(wallets).forEach(w => {
            if (w.history) {
                w.history.forEach(h => {
                    if (h.type === 'RECHARGE_CREDIT') totalDeposits += h.amount;
                    if (h.type === 'WITHDRAWAL_PAID') totalWithdraws += h.amount;
                });
            }
        });

        const activeProviders = settings.providers ? settings.providers.filter(p => p.status === 'active').length : 0;
        const databaseHealthy = fs.existsSync(DB_DIR) ? 'HEALTHY' : 'UNSTABLE';

        const msg = `⚡ <b>ENTERPRISE SaaS DASHBOARD</b>\n─────────────────────────\n` +
            `👥 <b>User Base:</b>\n` +
            ` • Total Accounts: <b>${totalUsers}</b>\n` +
            ` • Active Profiles: <b>${activeUsersCount}</b>\n\n` +
            `📦 <b>SaaS Order Pipeline:</b>\n` +
            ` • Active WAITING Lines: <b>${pendingOrders}</b>\n` +
            ` • Completed Deliveries: <b>${completedOrders}</b>\n` +
            ` • Cancelled/Expired Lines: <b>${cancelledOrders}</b>\n` +
            ` • Total Managed Orders: <b>${totalOrders}</b>\n\n` +
            `💰 <b>Platform Cash Ledgers:</b>\n` +
            ` • Gross Sales Volume: <b>${settings.currency}${totalRevenue.toFixed(2)}</b>\n` +
            ` • Gross Cleared Deposits: <b>${settings.currency}${totalDeposits.toFixed(2)}</b>\n` +
            ` • Gross Cleared Withdraws: <b>${settings.currency}${totalWithdraws.toFixed(2)}</b>\n\n` +
            `🔋 <b>System Diagnostics:</b>\n` +
            ` • Failover Provider Nodes: <b>${activeProviders} Active</b>\n` +
            ` • JSON Storage Engine: <b>${databaseHealthy}</b>\n` +
            ` • Platform Port: <code>${config.PORT}</code>\n\n` +
            `Select an administration module below:`;

        const markup = {
            inline_keyboard: [
                [{ text: '📦 Products Directory', callback_data: 'admin_products' }, { text: '👥 Users Auditor', callback_data: 'admin_users' }],
                [{ text: '🗂 Category Manager', callback_data: 'admin_categories' }, { text: '🌐 Country Manager', callback_data: 'admin_countries' }],
                [{ text: '🛠 Service Manager', callback_data: 'admin_services' }, { text: '🔌 Gateway Failovers', callback_data: 'admin_providers' }],
                [{ text: '📥 Recharges Queue', callback_data: 'admin_recharges' }, { text: '📤 Withdraws Queue', callback_data: 'admin_withdraws' }],
                [{ text: '📊 Analytics Reports', callback_data: 'admin_stats' }, { text: '📜 Audit Logs', callback_data: 'admin_logs' }],
                [{ text: '💾 Backup Database', callback_data: 'admin_backup' }, { text: '📣 Broadcast System', callback_data: 'admin_broadcast_init' }],
                [{ text: '⚠️ Fraud Center Audit', callback_data: 'admin_fraud_center' }, { text: '⚙ System Configs', callback_data: 'admin_configs' }],
               [{ text: '📢 Force Join Manager', callback_data: 'admin_forcejoin' }] 
]
        };

        logger.info('ADMIN_ACTION', 'Loaded SaaS panel dashboard.', ctx.from?.id);
        return safeEdit(ctx, msg, { parse_mode: 'HTML', reply_markup: markup });
    } catch (err) {
        logger.error('ERROR', `renderAdminMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

/**
 * Backward compatibility wrapper.
 */
function renderAdminDashboard(ctx) {
    return renderAdminMenu(ctx);
}

// ==========================================
// 📦 MODULE: PRODUCT MANAGEMENT & WIZARDS
// ==========================================
async function productWizard(ctx) {
    try {
        const products = loadDb('products.json');
        const settings = loadDb('settings.json');

        let txt = `📦 <b>Select Product</b>`;
        const buttons = [];

        for (const p of products) {

            let price;

            if (p.manualPrice != null) {

                price = `${settings.currency}${Number(p.manualPrice).toFixed(2)} 🔒`;

            } else {

                let providerCost = Number(p.price || 0);

                try {
                    const rates = await providerService.getBestProviderAndPrice(
                        p.code,
                        p.countryCode
                    );

                    if (Array.isArray(rates) && rates.length) {
                        const best = rates[0];
                        providerCost = Number(
                            best.price !== undefined
                                ? best.price
                                : (
                                    best.cost !== undefined
                                        ? best.cost
                                        : providerCost
                                )
                        );
                    }
                } catch (e) {}

                const usd = Number(settings.usd_to_inr || 105);
                const profit = Number(settings.profit_percent || 10);

                const finalPrice =
                    Number((providerCost * usd * (1 + profit / 100)).toFixed(2));

                price = `${settings.currency}${finalPrice.toFixed(2)} 🌐`;
            }

            buttons.push([
                {
                    text: `📦 ${p.name} • ${p.country || 'Unknown'} • ${price}`,
                    callback_data: `adm_prod_view_${p.id}`
                }
            ]);
        }

        buttons.push([
            {
                text: '➕ Add Product Profile',
                callback_data: 'adm_prod_add_init'
            }
        ]);

        buttons.push([
            {
                text: '⬅️ Back to Admin',
                callback_data: 'admin_menu'
            }
        ]);

        return safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `productWizard crashed: ${err.message}`,
            ctx.from?.id
        );
    }
}
/**
 * Backward compatibility wrapper.
 */
function renderProductsAdmin(ctx) {
    return productWizard(ctx);
}

// Helpers for the Product creation Wizard UI states
function renderWizardStep(ctx, stepNumber, promptText, backCallback = null) {
    const buttons = [];
    if (backCallback) {
        buttons.push({ text: '⬅️ Back', callback_data: backCallback });
    }
    buttons.push({ text: '❌ Cancel', callback_data: 'admin_products' });
    buttons.push({ text: '🏠 Admin Home', callback_data: 'admin_menu' });

    return safeEdit(ctx, `📦 <b>PRODUCT WIZARD: STEP ${stepNumber}/7</b>\n─────────────────────────\n${promptText}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [buttons] }
    });
}

function renderProductSuccess(ctx, product) {
    const settings = loadDb('settings.json');
    const txt = `✅ <b>PRODUCT CREATED SUCCESSFULLY</b>\n─────────────────────────\n` +
        `📦 Name: <b>${product.name}</b>\n` +
        `🎭 Emoji Layout: <b>${product.emoji}</b>\n` +
        `💰 Unit Price: <b>${settings.currency}${Number(product.manualPrice ?? product.price ?? 0).toFixed(2)}</b>\n` +
        `📁 Category: <b>${product.category}</b>\n` +
        `🔌 Provider Identifier Code: <code>${product.code}</code>`;

    const buttons = [
        [{ text: '➕ Add Another', callback_data: 'adm_prod_add_init' }],
        [{ text: '📦 Product List', callback_data: 'admin_products' }],
        [{ text: '🏠 Admin Dashboard', callback_data: 'admin_menu' }]
    ];

    return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}
function renderProductConfirm(ctx, product) {
    const settings = loadDb('settings.json');

    const txt =
`📦 <b>CONFIRM NEW PRODUCT</b>
─────────────────────────

📁 Category: <b>${product.category}</b>
🌍 Country: <b>${product.country}</b>
📱 Name: <b>${product.name}</b>
😀 Emoji: ${product.emoji}
💰 Price: <b>${settings.currency}${Number(product.manualPrice ?? product.price ?? 0).toFixed(2)}</b>
📝 Description:
${product.description}

🔑 Provider Code:
<code>${product.code}</code>

Confirm this product?`;

    return safeEdit(ctx, txt, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '✅ Confirm',
                        callback_data: 'adm_prod_add_confirm'
                    }
                ],
                [
                    {
                        text: '⬅️ Back',
                        callback_data: 'adm_prod_back_step7'
                    }
                ],
                [
                    {
                        text: '❌ Cancel',
                        callback_data: 'admin_products'
                    }
                ]
            ]
        }
    });
}
/**
 * Initializes the wizard by dynamically loading configured categories from database storage.
 */
function handleProductAddInit(ctx) {
    try {
        ctx.session.step = 'ADM_PROD_SELECT_CATEGORY';
        ctx.session.newProduct = {};

        const categories = loadDb('categories.json') || [];
        const buttons = categories.map(cat => {
            const catName = typeof cat === 'object' ? (cat.name || '') : cat;
            return [
                {
                    text: `📁 ${catName}`,
                    callback_data: `cat_add_${catName}`
                }
            ];
        });

        buttons.push([
            {
                text: '➕ Add New Category',
                callback_data: 'adm_cat_add'
            }
        ]);

        buttons.push([
            {
                text: '❌ Cancel',
                callback_data: 'admin_products'
            },
            {
                text: '🏠 Admin Home',
                callback_data: 'admin_menu'
            }
        ]);

        return safeEdit(ctx, '📂 <b>Select Category</b>\n\nChoose a category first to continue setup:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });
    } catch (err) {
        logger.error('ERROR', `handleProductAddInit crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 🗂 MODULE: CATEGORY MANAGER
// ==========================================
function renderCategoryManagerMenu(ctx) {
    try {
        let categories = [];
        try {
            categories = loadDb('categories.json');
            if (!Array.isArray(categories)) categories = [];
        } catch (e) {
            categories = [];
        }

        let txt = `🗂 <b>CATEGORY MANAGER</b>\n─────────────────────────\n`;
        const buttons = [];

        if (categories.length === 0) {
            txt += `<i>No custom categories configured.</i>\n`;
        } else {
            categories.forEach((cat, idx) => {
                const catName = typeof cat === 'object' ? (cat.name || '') : cat;
                txt += ` • <b>${catName}</b>\n`;
                buttons.push([
                    { text: '✏️ Rename', callback_data: `adm_cat_ren_init_${idx}` },
                    { text: '❌ Delete', callback_data: `adm_cat_del_${idx}` }
                ]);
            });
        }

        buttons.push([{ text: '➕ Add Category', callback_data: 'adm_cat_add' }]);
        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderCategoryManagerMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

async function handleCategoryAddInit(ctx) {
    try {
        ctx.session.adminState = 'awaiting_category_add';
        await ctx.answerCbQuery().catch(() => {});
        return await ctx.reply('➕ Please enter the name of your new custom Category:');
    } catch (err) {
        logger.error('ERROR', `handleCategoryAddInit crashed: ${err.message}`, ctx.from?.id);
    }
}

async function handleCategoryDelete(ctx, index) {
    try {
        let categories = [];
        try {
            categories = loadDb('categories.json');
            if (!Array.isArray(categories)) categories = [];
        } catch (e) {}

        const idx = parseInt(index, 10);
        if (!isNaN(idx) && categories[idx] !== undefined) {
            const deleted = categories[idx];
            categories.splice(idx, 1);
            saveDb('categories.json', categories);
            const name = typeof deleted === 'object' ? (deleted.name || '') : deleted;
            await ctx.answerCbQuery(`Deleted category: ${name}`).catch(() => {});
        } else {
            await ctx.answerCbQuery('❌ Index matching lookup failed.').catch(() => {});
        }
        return renderCategoryManagerMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `handleCategoryDelete crashed: ${err.message}`, ctx.from?.id);
    }
}

async function handleCategoryRenameInit(ctx, index) {
    try {
        ctx.session.renameCatIndex = parseInt(index, 10);
        ctx.session.adminState = 'awaiting_category_rename';
        await ctx.answerCbQuery().catch(() => {});
        return await ctx.reply('✏️ Please enter the new name for the category:');
    } catch (err) {
        logger.error('ERROR', `handleCategoryRenameInit crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 🌐 MODULE: COUNTRY MANAGER
// ==========================================
function renderCountryManagerMenu(ctx) {
    try {

        let countries = [];
        try {
            countries = loadDb('countries_db.json');
            if (!Array.isArray(countries)) countries = [];
        } catch (e) {
            countries = [];
        }

        let txt = `🌐 <b>COUNTRY MANAGER</b>\n─────────────────────────\n`;
        const buttons = [];

        if (countries.length === 0) {
            txt += `<i>No custom countries configured.</i>\n`;
        } else {
            countries.forEach((c, idx) => {
txt += ` • ${c.emoji || '🏳️'} <b>${c.name}</b> (Code: <code>${c.id || c.code}</code>)\n`;
                buttons.push([
                    { text: `❌ Delete ${c.name}`, callback_data: `adm_country_del_${idx}` }
                ]);
            });
        }

        buttons.push([{ text: '➕ Add Country', callback_data: 'adm_country_add' }]);
        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderCountryManagerMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

async function handleCountryAddInit(ctx) {
    try {
        ctx.session.adminState = 'awaiting_country_name';
        await ctx.answerCbQuery().catch(() => {});
        return await ctx.reply('🌍 Please enter the country name (e.g. India):');
    } catch (err) {
        logger.error('ERROR', `handleCountryAddInit crashed: ${err.message}`, ctx.from?.id);
    }
}

async function handleCountryDelete(ctx, index) {
    try {
        let countries = [];
        try {
            countries = loadDb('countries_db.json');
            if (!Array.isArray(countries)) countries = [];
        } catch (e) {}

        const idx = parseInt(index, 10);
        if (!isNaN(idx) && countries[idx] !== undefined) {
            const deleted = countries[idx];
            countries.splice(idx, 1);
            saveDb('countries_db.json', countries);
            await ctx.answerCbQuery(`Deleted country: ${deleted.name || ''}`).catch(() => {});
        } else {
            await ctx.answerCbQuery('❌ Index matching lookup failed.').catch(() => {});
        }
        return renderCountryManagerMenu(ctx);
    } catch (err) {
        logger.error('ERROR', `handleCountryDelete crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 🛠 MODULE: SERVICE MANAGER
// ==========================================
function renderServiceManagerMenu(ctx) {
    try {
        let services = [];
        try {
            services = loadDb('services.json');
            if (!Array.isArray(services)) services = [];
        } catch (e) {
            services = [];
        }

        let txt = `🛠 <b>SERVICE MANAGER</b>\n─────────────────────────\n`;
        const buttons = [];

        if (services.length === 0) {
            txt += `<i>No custom services configured.</i>\n`;
        } else {
            services.forEach((s, idx) => {
                txt += ` • <b>${s.name}</b> (Category: <b>${s.category}</b>, Price: <b>${s.price}</b>)\n`;
                buttons.push([
                    { text: `🔎 Manage ${s.name}`, callback_data: `adm_svc_sub_${idx}` },
                    { text: `❌ Delete`, callback_data: `adm_svc_del_${idx}` }
                ]);
            });
        }

        buttons.push([{ text: '➕ Add Service', callback_data: 'adm_svc_add' }]);
        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderServiceManagerMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

function renderServiceSubmenu(ctx, serviceIndex) {
    try {
        let services = [];
        try {
            services = loadDb('services.json');
        } catch (e) {}

        const s = services[serviceIndex];
        if (!s) {
            return ctx.reply('❌ Service not found.');
        }

        const txt = `🛠 <b>SERVICE DETAILS: ${s.name}</b>\n─────────────────────────\n` +
            `📂 Category: <b>${s.category}</b>\n` +
            `💰 Price: <b>${s.price}</b>\n` +
            `🔌 Code: <code>${s.code || 'N/A'}</code>\n` +
            `🟢 Status: <b>${s.status || 'active'}</b>`;

        const buttons = [
            [{ text: '💰 Edit Price', callback_data: `adm_svc_price_${serviceIndex}` }],
            [{ text: '⬅️ Back to Service Manager', callback_data: 'admin_services' }]
        ];

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderServiceSubmenu crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 👥 MODULE: USER MANAGEMENT & ACTIONS
// ==========================================
function renderUserEditPanel(ctx, targetId) {
    try {
        const user = loadDb('users.json')[targetId];
        const wallets = loadDb('wallet.json');
        const uWallet = wallets[targetId] || { balance: 0.0 };

        if (!user) return ctx.reply('❌ User identity profile records missing.');

        const settings = loadDb('settings.json');
        const isBanned = settings.banned_users && settings.banned_users.includes(targetId);
const referrals =
    loadDb('referrals.json') || {};

const refData =
    referrals[targetId] || {
        referredUsers: [],
        earnings: {
            total: 0
        }
    };

const orders =
    loadDb('orders.json') || [];

const userOrders =
    orders.filter(
        o => o.userId === targetId
    );

const totalDeposits =
    (uWallet.history || [])
    .filter(
        h => h.type === 'RECHARGE_CREDIT'
    )
    .reduce(
        (a, b) => a + b.amount,
        0
    );

const totalWithdraws =
    (uWallet.history || [])
    .filter(
        h => h.type === 'WITHDRAWAL_PAID'
    )
    .reduce(
        (a, b) => a + b.amount,
        0
    );
const txt =
`👤 <b>USER OVERVIEW</b>

🆔 User ID: <code>${targetId}</code>
👤 Name: <b>${user.first_name}</b>
🔑 Username: @${user.username || 'N/A'}

💰 Wallet Balance: <b>${settings.currency}${uWallet.balance.toFixed(2)}</b>
📥 Total Deposits: <b>${settings.currency}${totalDeposits}</b>
📤 Total Withdrawals: <b>${settings.currency}${totalWithdraws}</b>

🎁 Referral Earnings: <b>${settings.currency}${refData.earnings.total}</b>
👥 Total Referrals: <b>${refData.referredUsers.length}</b>

📦 Total Orders: <b>${userOrders.length}</b>

📅 Joined:
<b>${
user.joinedAt
? new Date(user.joinedAt).toLocaleDateString()
: 'N/A'
}</b>

🛡 Role: <b>${user.role || 'User'}</b>
⚖ Status: <b>${isBanned ? 'Banned' : 'Active'}</b>`;


const buttons = [

    [
        {
            text: '📜 Wallet History',
            callback_data: `adm_wallet_${targetId}`
        },
        {
            text: '📦 Orders',
            callback_data: `adm_orders_${targetId}`
        }
    ],

    [
        {
            text: '📥 Deposits',
            callback_data: `adm_deposits_${targetId}`
        },
        {
            text: '📤 Withdrawals',
            callback_data: `adm_withdraws_${targetId}`
        }
    ],

    [
        {
            text: '🎁 Referrals',
            callback_data: `adm_refs_${targetId}`
        },
        {
            text: '⚙️ Actions',
            callback_data: `adm_actions_${targetId}`
        }
    ],

    [
        {
            text: '⬅️ Back',
            callback_data: 'admin_users'
        }
    ]

];

        return safeEdit(ctx, txt, {
    parse_mode: 'HTML',
    reply_markup: {
        inline_keyboard: buttons
    }
});

    } catch (err) {
        logger.error('ERROR', `renderUserEditPanel failed: ${err.message}`, ctx.from.id);
    }
}


// ==========================================
// 📥 MODULE: RECHARGE QUEUE
// ==========================================
function renderRechargeQueue(ctx) {
    try {
        const settings = loadDb('settings.json');
        const pending = settings.pending_payments || [];
        let txt = `📥 <b>MANUAL DEPOSIT RECHARGE QUEUE</b>\n─────────────────────────\n`;
        const buttons = [];

        if (pending.length === 0) {
            txt += '<i>No active payment verifications pending review.</i>';
        } else {
            pending.forEach(p => {
                txt += `👤 User ID: <code>${p.userId}</code>\n` +
                    `💰 Amount: <b>${settings.currency}${p.amount}</b>\n` +
                    `📝 Reference Code: <code>${p.utr}</code>\n` +
                    `⏱ Time: ${p.timestamp}\n\n`;
                buttons.push([
                    { text: `✅ Approve ${settings.currency}${p.amount}`, callback_data: `adm_pay_app_${p.id}` },
                    { text: `❌ Reject`, callback_data: `adm_pay_rej_${p.id}` }
                ]);
            });
        }

        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderRechargeQueue crashed: ${err.message}`, ctx.from.id);
    }
}

// ==========================================
// 📤 MODULE: WITHDRAWAL QUEUE
// ==========================================
function renderWithdrawQueue(ctx) {
    try {
        const settings = loadDb('settings.json');
        const pending = settings.pending_withdrawals || [];
        let txt = `📤 <b>MANUAL WITHDRAWAL QUEUE</b>\n─────────────────────────\n`;
        const buttons = [];

        if (pending.length === 0) {
            txt += '<i>No active withdrawals pending payout validation.</i>';
        } else {
            pending.forEach(w => {
                txt += `👤 User ID: <code>${w.userId}</code>\n` +
                    `💰 Amount: <b>${settings.currency}${w.amount}</b>\n` +
                    `📝 Destination: <code>${w.details}</code>\n` +
                    `⏱ Time: ${w.timestamp}\n\n`;
                buttons.push([
                    { text: `✅ Confirm Payout`, callback_data: `adm_wtd_app_${w.id}` },
                    { text: `❌ Reject`, callback_data: `adm_wtd_rej_${w.id}` }
                ]);
            });
        }

        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderWithdrawQueue crashed: ${err.message}`, ctx.from.id);
    }
}

// ==========================================
// 🔌 MODULE: FAILOVER PROVIDERS
// ==========================================
function renderProviderSettingsMenu(ctx) {
    try {
        const providers = loadDb('providers.json');
        const settings = loadDb('settings.json');
        let txt = `🔌 <b>FAILOVER ROUTING GATEWAYS</b>\n─────────────────────────\n`;
        const buttons = [];

        providers.forEach(p => {
            const symbol = p.status === 'active' ? '🟢' : '🔴';
            txt += `• <b>${p.name}</b> [Priority: ${p.priority}] [${p.status.toUpperCase()}]\n${p.url}\n\n`;
            buttons.push([
                { text: `${symbol} Toggle`, callback_data: `adm_prov_toggle_${p.id}` },
                { text: `🩺 Test API`, callback_data: `adm_prov_test_${p.id}` },
                { text: `🗑 Remove`, callback_data: `adm_prov_del_${p.id}` }
            ]);
        });

        buttons.push([{ text: '➕ Register Provider Gateway', callback_data: 'adm_prov_add_init' }]);
        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderProviderSettingsMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

/**
 * Backward compatibility wrapper.
 */
function renderProvidersAdmin(ctx) {
    return renderProviderSettingsMenu(ctx);
}

// ==========================================
// ⚠️ MODULE: FRAUD CENTER
// ==========================================
function renderFraudCenter(ctx) {
    try {
        const flagged = loadDb('flaggedReferrals.json');
        const settings = loadDb('settings.json');
        let txt = `⚠️ <b>FRAUD CONTROL AUDIT CENTER</b>\n─────────────────────────\n`;
        const buttons = [];

        if (flagged.length === 0) {
            txt += '<i>No suspicious activities flagged. All ledger records clear.</i>';
        } else {
            flagged.forEach(f => {
                txt += `👤 Referrer: <code>${f.referrerId}</code>\n` +
                    `👥 Referee: <code>${f.refereeId}</code> (${f.refereeName})\n` +
                    `💰 Payout: ${settings.currency}${f.amount.toFixed(2)}\n` +
                    `🚨 Risk Index: <b>${f.score}/100</b>\n` +
                    `📝 Triggers: <i>${f.reasons.join(', ')}</i>\n` +
                    `⏱ Time: ${f.timestamp}\n\n`;
                buttons.push([
                    { text: '✅ Approve Payout', callback_data: `adm_fraud_app_${f.id}` },
                    { text: '❌ Reject & Void', callback_data: `adm_fraud_rej_${f.id}` }
                ]);
            });
        }

        buttons.push([{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]);
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderFraudCenter crashed: ${err.message}`, ctx.from.id);
    }
}

// ==========================================
// ⚙ MODULE: SYSTEM SETTINGS
// ==========================================
function renderConfigsAdmin(ctx) {
    try {
         const settings = loadDb('settings.json');
        const txt = `⚙ <b>PLATFORM CONTROL PANEL</b>\n─────────────────────────\n` +
            `🤖 Bot Display Name: <b>${settings.bot_name}</b>\n` +
            `💬 Customer Support Handle: <b>@${settings.support_username}</b>\n` +
            `💳 Currency Symbol: <b>${settings.currency}</b>\n` +
            `🎁 Affiliate Percentage: <b>${settings.referral_percent}%</b>\n` +
             `💰 Profit Percentage: <b>${settings.profit_percent || 10}%</b>\n` +
            `📥 Min Deposit Limit: <b>${settings.currency}${settings.min_recharge}</b>\n` +
            `⏱ Order Timeout: <b>${settings.order_timeout} seconds</b>\n` +
            `🛠 Maintenance Mode: <b>${settings.maintenance_mode ? 'ACTIVE' : 'DISABLED'}</b>`;

        const buttons = [
            [{ text: '🤖 Platform Name', callback_data: 'adm_cfg_botname_init' }, { text: '💬 Support Handle', callback_data: 'adm_cfg_support_init' }],
            [{ text: '💳 Currency Symbol', callback_data: 'adm_cfg_currency_init' }, { text: '🎁 Affiliate Payout %', callback_data: 'adm_cfg_ref_init' }],
[
 { text: '📥 Min Deposit Limit', callback_data: 'adm_cfg_min_init' },
 { text: '🏦 UPI ID', callback_data: 'adm_cfg_upi_init' }
],
[
 { text: '⏱ Order Timeout Window', callback_data: 'adm_cfg_timeout_init' },
 { text: '💰 Profit %', callback_data: 'adm_cfg_profit_init' }
],
            [{ text: `🛠 Maintenance: ${settings.maintenance_mode ? 'DISABLE' : 'ENABLE'}`, callback_data: 'adm_cfg_maint_toggle' }],
            [{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]
        ];

        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderConfigsAdmin crashed: ${err.message}`, ctx.from.id);
    }
}

// ==========================================
// 💾 MODULE: BACKUP CENTER (ZIP UTILITIES)
// ==========================================
async function handleSystemBackup(ctx) {
    try {
        await ctx.answerCbQuery('📦 Packaging local JSON data blocks...');
        const zip = new AdmZip();

        const targets = [
            'users.json', 'wallet.json', 'orders.json', 'products.json',
            'settings.json', 'logs.json', 'referrals.json', 'flaggedReferrals.json',
            'providers.json', 'transactions.json'
        ];

        targets.forEach(target => {
            const pth = path.join(DB_DIR, target);
            if (fs.existsSync(pth)) {
                zip.addLocalFile(pth);
            }
        });

        const zipPath = path.join(DB_DIR, 'Platform_Database_Backup.zip');
        zip.writeZip(zipPath);

        await ctx.replyWithDocument({ source: zipPath, filename: 'System_Database_Backup.zip' });
        fs.unlinkSync(zipPath); // Clean up transient ZIP
        
        logger.info('ADMIN_ACTION', 'Generated full platform ZIP backup.', ctx.from.id);
    } catch (err) {
        logger.error('ERROR', `Backup zip generation failed: ${err.message}`, ctx.from.id);
        await ctx.reply(`❌ <b>Backup package generation failed:</b> ${err.message}`, { parse_mode: 'HTML' });
    }
}

// ==========================================
// 📈 MODULE: ANALYTICS & LEDGERS
// ==========================================
function renderProductAnalytics(ctx) {
    try {
         const orders = loadDb('orders.json');
        const wallets = loadDb('wallet.json');
        const settings = loadDb('settings.json');

        let completed = 0;
        let cancelled = 0;
        let revenue = 0;
        let refunded = 0;

        orders.forEach(o => {
            if (o.status === 'COMPLETED') {
                completed++;
                revenue += o.price;
            } else if (o.status === 'CANCELLED') {
                cancelled++;
                refunded += o.price;
            }
        });

        let totalDepositsVal = 0;
        Object.values(wallets).forEach(w => {
            if (w.history) {
                totalDepositsVal += w.history
                    .filter(h => h.type === 'RECHARGE_CREDIT')
                    .reduce((acc, curr) => acc + curr.amount, 0);
            }
        });

        const successRate = orders.length > 0 ? ((completed / orders.length) * 100).toFixed(1) : 0;

        const txt = `📈 <b>SaaS ANALYTICS REPORT</b>\n─────────────────────────\n` +
            `🎯 Successful Delivery Rate: <b>${successRate}%</b>\n` +
            `✅ Completed Orders: <b>${completed}</b>\n` +
            `❌ Spliced/Refunded Lines: <b>${cancelled}</b>\n\n` +
            `💰 Gross sales: <b>${settings.currency}${revenue.toFixed(2)}</b>\n` +
            `📥 Gross processed deposits: <b>${settings.currency}${totalDepositsVal.toFixed(2)}</b>\n` +
            `🔄 Returned Ledger Credits: <b>${settings.currency}${refunded.toFixed(2)}</b>\n\n` +
            `⚙ Reports synchronized onto memory-safe disk writes.`;

        const buttons = [[{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]];
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderProductAnalytics crashed: ${err.message}`, ctx.from?.id);
    }
}

/**
 * Backward compatibility wrapper.
 */
function renderAdminStats(ctx) {
    return renderProductAnalytics(ctx);
}

// ==========================================
// 📜 MODULE: SYSTEM AUDIT LOGS
// ==========================================
function renderAuditLogs(ctx) {
    try {
        let logs = [];
        try {
            logs = loadDb('logs.json');
            if (!Array.isArray(logs)) {
                if (logs && Array.isArray(logs.logs)) {
                    logs = logs.logs;
                } else if (logs && typeof logs === 'object') {
                    logs = Object.values(logs);
                } else {
                    logs = [];
                }
            }
        } catch (e) {
            logs = [];
        }

        let txt = `📜 <b>SYSTEM AUDIT LOGS</b>\n─────────────────────────\n`;
        if (logs.length === 0) {
            txt += `<i>No recent system audit logs found.</i>`;
        } else {
            const recentLogs = logs.slice(-10).reverse();
            recentLogs.forEach(l => {
                const time = l.timestamp || new Date().toISOString();
                const type = l.type || 'INFO';
                const message = l.message || '';
                txt += `• <code>[${time}]</code> [${type}] ${message}\n\n`;
            });
        }

        const buttons = [[{ text: '⬅️ Back to Admin', callback_data: 'admin_menu' }]];
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderAuditLogs crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// ⌨ MODULE: ADMIN STATE TEXT INPUTS
// ==========================================
async function handleAdminTextInput(ctx) {
    try {
        const state = ctx.session?.adminState || ctx.session?.step;
        if (!state) return false;

        const text = ctx.message?.text?.trim();
        if (!text) return false;

        // Reset state so it doesn't process repeatedly
if (ctx.session.adminState) {
    ctx.session.adminState = null;
}
        if (state === 'awaiting_category_add') {
            let categories = [];
            try { categories = loadDb('categories.json'); } catch(e){}
            if (!Array.isArray(categories)) categories = [];

            const newCat = text.trim();
            if (newCat) {
                if (!categories.includes(newCat)) {
                    categories.push(newCat);
                    saveDb('categories.json', categories);
                    await ctx.reply(`✅ Category <b>${newCat}</b> added successfully!`, { parse_mode: 'HTML' });
                } else {
                    await ctx.reply(`⚠️ Category <b>${newCat}</b> already exists.`, { parse_mode: 'HTML' });
                }
            }
            return renderCategoryManagerMenu(ctx);
        }

        if (state === 'awaiting_category_rename') {
            const index = ctx.session.renameCatIndex;
            ctx.session.renameCatIndex = null;

            let categories = [];
            try { categories = loadDb('categories.json'); } catch(e){}
            if (!Array.isArray(categories)) categories = [];

            const newName = text.trim();
            if (newName && index !== undefined && categories[index] !== undefined) {
                const oldName = categories[index];
                categories[index] = newName;
                saveDb('categories.json', categories);
                await ctx.reply(`✅ Category renamed from <b>${oldName}</b> to <b>${newName}</b>!`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply('⚠️ Invalid rename operation.');
            }
            return renderCategoryManagerMenu(ctx);
        }

        if (state === 'awaiting_country_name') {
            ctx.session.tempCountry = { name: text };
            ctx.session.adminState = 'awaiting_country_code';
            await ctx.reply(`📝 Now enter the ISO / dynamic numerical provider code for <b>${text}</b> (e.g., <code>22</code> for India, <code>1</code> for USA):`, { parse_mode: 'HTML' });
            return true;
        }

        if (state === 'awaiting_country_code') {
            const name = ctx.session.tempCountry?.name;
            if (!name) return false;

            ctx.session.tempCountry.code = text.toUpperCase();
            ctx.session.adminState = 'awaiting_country_emoji';
            await ctx.reply(`📝 Finally, enter an emoji flag for this country (e.g., 🇺🇸 or 🇮🇳):`);
            return true;
        }

if (state === 'awaiting_country_emoji') {
    const temp = ctx.session.tempCountry;
    if (!temp) return false;

    let countries = [];
    try {
        countries = loadDb('countries_db.json');
    } catch (e) {}

    if (!Array.isArray(countries)) countries = [];

    countries.push({
        id: temp.code.toString(),
        code: temp.code.toString(),
        name: temp.name,
        emoji: text,
        enabled: true
    });

    saveDb('countries_db.json', countries);

    await ctx.reply(
        `✅ Country <b>${temp.name}</b> added successfully!`,
        { parse_mode: 'HTML' }
    );

    ctx.session.tempCountry = null;
    ctx.session.adminState = null;

    return renderCountryManagerMenu(ctx);
}
if (state === 'ADM_PROD_SEARCH_COUNTRY') {
    const countries = loadDb('countries_db.json') || [];

    const country = countries.find(c =>
        c.name.toLowerCase() === text.toLowerCase()
    );

    if (!country) {
        await ctx.reply('❌ Country not found.');
        return true;
    }

    ctx.session.newProduct = ctx.session.newProduct || {};
    ctx.session.newProduct.country = country.name;
    ctx.session.newProduct.countryCode = parseInt(country.id || country.code, 10);

    ctx.session.step = 'ADM_PROD_ADD_NAME';

    return renderWizardStep(
        ctx,
        3,
        '📱 Enter Service Name (Example: Telegram, WhatsApp, Google):'
    );
}


        if (state === 'awaiting_service_name') {
            ctx.session.tempService = { name: text };
            ctx.session.adminState = 'awaiting_service_category';
            await ctx.reply(`📝 Enter the category name for this service:`);
            return true;
        }

        if (state === 'awaiting_service_category') {
            if (!ctx.session.tempService) return false;
            ctx.session.tempService.category = text;
            ctx.session.adminState = 'awaiting_service_price';
            await ctx.reply(`📝 Enter the unit price (e.g., 1.50):`);
            return true;
        }

        if (state === 'awaiting_service_price') {
            if (!ctx.session.tempService) return false;
            const price = parseFloat(text);
            if (isNaN(price)) {
                await ctx.reply('❌ Invalid price value. Please enter a valid number:');
                ctx.session.adminState = 'awaiting_service_price';
                return true;
            }
            ctx.session.tempService.price = price;
            ctx.session.adminState = 'awaiting_service_code';
            await ctx.reply(`📝 Enter the internal service code or provider API identifier (e.g., <code>INSTA_LIKE_10</code>):`, { parse_mode: 'HTML' });
            return true;
        }

        if (state === 'awaiting_service_code') {
            const temp = ctx.session.tempService;
            if (!temp) return false;

            let services = [];
            try { services = loadDb('services.json'); } catch(e){}
            if (!Array.isArray(services)) services = [];

            services.push({
                name: temp.name,
                category: temp.category,
                price: temp.price,
                code: text,
                status: 'active'
            });
            saveDb('services.json', services);

            await ctx.reply(`✅ Service <b>${temp.name}</b> added successfully!`, { parse_mode: 'HTML' });
            ctx.session.tempService = null;
            return renderServiceManagerMenu(ctx);
        }

if (state.startsWith('awaiting_u_addbal_') || state.startsWith('ADM_U_ADDBAL') || state === 'ADM_U_ADDBAL') {

    const targetId = ctx.session.editTargetUserId;
    const amount = parseFloat(text);

    if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Invalid amount. Transaction aborted.');
        return renderUserEditPanel(ctx, targetId);
    }

    const wallets = loadDb('wallet.json');

    if (!wallets[targetId]) {
        wallets[targetId] = { balance: 0.0, history: [] };
    }

    wallets[targetId].balance += amount;

    if (!wallets[targetId].history) {
        wallets[targetId].history = [];
    }

    wallets[targetId].history.push({
        type: 'RECHARGE_CREDIT',
        amount: amount,
        timestamp: new Date().toISOString()
    });

    saveDb('wallet.json', wallets);

    await ctx.reply(
        `✅ Added <b>${amount.toFixed(2)}</b> to user's wallet.`,
        { parse_mode: 'HTML' }
    );

    return renderUserEditPanel(ctx, targetId);
}

 if (state.startsWith('awaiting_u_dedbal_') || state.startsWith('ADM_U_DEDBAL') || state === 'ADM_U_DEDBAL') {

    const targetId = ctx.session.editTargetUserId;
    const amount = parseFloat(text);

    if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Invalid amount. Transaction aborted.');
        return renderUserEditPanel(ctx, targetId);
    }

    const wallets = loadDb('wallet.json');

    if (!wallets[targetId]) {
        wallets[targetId] = { balance: 0.0, history: [] };
    }

    wallets[targetId].balance = Math.max(
        0,
        wallets[targetId].balance - amount
    );

    if (!wallets[targetId].history) {
        wallets[targetId].history = [];
    }

    wallets[targetId].history.push({
        type: 'DEBIT_MANUAL',
        amount: amount,
        timestamp: new Date().toISOString()
    });

    saveDb('wallet.json', wallets);

    await ctx.reply(
        `✅ Deducted <b>${amount.toFixed(2)}</b> from user's wallet.`,
        { parse_mode: 'HTML' }
    );

    return renderUserEditPanel(ctx, targetId);
}

        if (state.startsWith('awaiting_prod_price_') || state === 'ADM_PROD_EDIT_PRICE') {
            const prodId = state.startsWith('awaiting_prod_price_') ? state.replace('awaiting_prod_price_', '') : ctx.session.editProdId;
            const price = parseFloat(text);
            if (isNaN(price) || price < 0) {
                await ctx.reply('❌ Invalid price. Transaction aborted.');
                return renderProductsAdmin(ctx);
            }

            const products = loadDb('products.json');
            const pIndex = products.findIndex(p => p.id === prodId || p.id === parseInt(prodId, 10));
            if (pIndex !== -1) {
                products[pIndex].manualPrice = price;
                saveDb('products.json', products);
                await ctx.reply(
    `✅ Manual price override set to <b>₹${price.toFixed(2)}</b>.`,
    {
        parse_mode: 'HTML'
    }
);
            } else {
                await ctx.reply('❌ Product not found.');
            }
            return renderProductsAdmin(ctx);
        }
if (state === 'ADM_PROD_EDIT_NAME') {
    const prodId = ctx.session.editProdId;
    const newName = text.trim();

    if (!newName) {
        await ctx.reply('❌ Product name cannot be empty.');
        return renderProductsAdmin(ctx);
    }

    const products = loadDb('products.json');
    const pIndex = products.findIndex(p => p.id === prodId);

    if (pIndex !== -1) {
        products[pIndex].name = newName;
        saveDb('products.json', products);

        ctx.session.step = null;
        ctx.session.editProdId = null;

        await ctx.reply('✅ Product name updated.');
    } else {
        await ctx.reply('❌ Product not found.');
    }

    return renderProductsAdmin(ctx);
}
if (state === 'ADM_PROD_EDIT_CATEGORY') {
    const prodId = ctx.session.editProdId;
    const products = loadDb('products.json');
    const index = products.findIndex(p => p.id === prodId);

    if (index !== -1) {
        products[index].category = text.trim();
        saveDb('products.json', products);

        ctx.session.step = null;
        ctx.session.editProdId = null;

        await ctx.reply('✅ Category updated.');
    } else {
        await ctx.reply('❌ Product not found.');
    }

    return renderProductsAdmin(ctx);
}

if (state === 'ADM_PROD_EDIT_CODE') {
    const prodId = ctx.session.editProdId;
    const products = loadDb('products.json');
    const index = products.findIndex(p => p.id === prodId);

    if (index !== -1) {
        products[index].code = text.trim();
        saveDb('products.json', products);

        ctx.session.step = null;
        ctx.session.editProdId = null;

        await ctx.reply('✅ Service code updated.');
    } else {
        await ctx.reply('❌ Product not found.');
    }

    return renderProductsAdmin(ctx);
}

if (state === 'ADM_PROD_EDIT_EMOJI') {
    const prodId = ctx.session.editProdId;
    const products = loadDb('products.json');
    const index = products.findIndex(p => p.id === prodId);

    if (index !== -1) {
        products[index].emoji = text.trim();
        saveDb('products.json', products);

        ctx.session.step = null;
        ctx.session.editProdId = null;

        await ctx.reply('✅ Emoji updated.');
    } else {
        await ctx.reply('❌ Product not found.');
    }

    return renderProductsAdmin(ctx);
}

        if (state.startsWith('awaiting_u_pm_') || state === 'ADM_U_PM') {
            const targetId = state.startsWith('awaiting_u_pm_') ? state.replace('awaiting_u_pm_', '') : ctx.session.editTargetUserId;
            try {
                await ctx.telegram.sendMessage(targetId, `✉️ <b>Message from Admin:</b>\n\n${text}`, { parse_mode: 'HTML' });
                await ctx.reply('✅ Message sent successfully.');
            } catch (err) {
                await ctx.reply(`❌ Failed to send message: ${err.message}`);
            }
            return renderUserEditPanel(ctx, targetId);
        }
if (state === 'ADM_USER_SEARCH') {

    const targetId = text.trim();

    const users = loadDb('users.json') || {};

    if (!users[targetId]) {

        await ctx.reply(
            '❌ User not found.'
        );

        return true;
    }

    ctx.session.step = null;

    return renderUserEditPanel(
        ctx,
        targetId
    );
}

        if (state === 'ADM_CFG_BOTNAME') {
            const settings = loadDb('settings.json');
            settings.bot_name = text;
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Platform name updated to: ${text}`);
            return renderConfigsAdmin(ctx);
        }

        if (state === 'ADM_CFG_SUPPORT') {
            const settings = loadDb('settings.json');
            settings.support_username = text.replace('@', '').trim();
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Support account redirected to: @${settings.support_username}`);
            return renderConfigsAdmin(ctx);
        }

        if (state === 'ADM_CFG_CURRENCY') {
            const settings = loadDb('settings.json');
            settings.currency = text;
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Currency symbol changed to: ${text}`);
            return renderConfigsAdmin(ctx);
        }

        if (state === 'ADM_CFG_REF') {
            const val = parseFloat(text);
            if (isNaN(val)) {
                await ctx.reply('❌ Invalid percentage value.');
                return renderConfigsAdmin(ctx);
            }
            const settings = loadDb('settings.json');
            settings.referral_percent = val;
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Referral percentage altered to: ${val}%`);
            return renderConfigsAdmin(ctx);
        }

        if (state === 'ADM_CFG_MIN') {
            const val = parseFloat(text);
            if (isNaN(val)) {
                await ctx.reply('❌ Invalid minimum value.');
                return renderConfigsAdmin(ctx);
            }
            const settings = loadDb('settings.json');
            settings.min_recharge = val;
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Minimum wallet recharge set to: ${settings.currency}${val}`);
            return renderConfigsAdmin(ctx);
        }
if (state === 'ADM_CFG_UPI') {

    const settings = loadDb('settings.json');

    settings.upi_id = text.trim();

    saveDb('settings.json', settings);

    ctx.session.step = 'ADM_CFG_QR';

    return ctx.reply(
        '✅ UPI Saved\n\n📷 Now Send QR Code Photo'
    );
}

        if (state === 'ADM_CFG_TIMEOUT') {
            const val = parseInt(text, 10);
            if (isNaN(val)) {
                await ctx.reply('❌ Invalid timeout value.');
                return renderConfigsAdmin(ctx);
            }
            const settings = loadDb('settings.json');
            settings.order_timeout = val;
            saveDb('settings.json', settings);
            await ctx.reply(`✅ Order timeout duration set to: ${val} seconds`);
            return renderConfigsAdmin(ctx);
        }
             if (state === 'ADM_CFG_PROFIT') {
    const val = parseFloat(text);

    if (isNaN(val) || val < 0) {
        await ctx.reply('❌ Invalid profit percentage.');
        return renderConfigsAdmin(ctx);
    }

    const settings = loadDb('settings.json');
    settings.profit_percent = val;
    saveDb('settings.json', settings);

    await ctx.reply(`✅ Profit percentage updated to ${val}%`);

    return renderConfigsAdmin(ctx);
}

        if (state === 'ADM_PROV_ADD_NAME') {
            ctx.session.newProvider = { id: 'prov_' + Math.random().toString(36).substring(2, 9), name: text, status: 'active' };
            ctx.session.step = 'ADM_PROV_ADD_URL';
            await ctx.reply('🔌 Enter Provider service base API URL:');
            return true;
        }

        if (state === 'ADM_PROV_ADD_URL') {
            if (!ctx.session.newProvider) return false;
            ctx.session.newProvider.url = text;
            ctx.session.step = 'ADM_PROV_ADD_KEY';
            await ctx.reply('🔑 Enter Provider Key authorization credentials:');
            return true;
        }

        if (state === 'ADM_PROV_ADD_KEY') {
            if (!ctx.session.newProvider) return false;
            ctx.session.newProvider.key = text;
            ctx.session.step = 'ADM_PROV_ADD_PRIORITY';
            await ctx.reply('⚙ Enter Provider routing execution Priority (1 = Highest):');
            return true;
        }

        if (state === 'ADM_PROV_ADD_PRIORITY') {
            if (!ctx.session.newProvider) return false;
            const priority = parseInt(text, 10);
            ctx.session.newProvider.priority = isNaN(priority) ? 5 : priority;

            const providers = loadDb('providers.json') || [];
            providers.push(ctx.session.newProvider);
            saveDb('providers.json', providers);

            ctx.session.newProvider = null;
            await ctx.reply('✅ Provider registered successfully!');
            return renderProviderSettingsMenu(ctx);
        }

        return false;
    } catch (err) {
        logger.error('ERROR', `handleAdminTextInput failed: ${err.message}`, ctx.from?.id);
        return false;
    }
}

// ==========================================
// 🚀 EXPORTS (INTEGRATES ORIGINAL & NEW)
// ==========================================
module.exports = {
    // Original/Existing Functions
    renderWizardStep,
    renderProductSuccess,
    renderProductConfirm,
    renderUserEditPanel,
    renderRechargeQueue,
    renderWithdrawQueue,
    renderFraudCenter,
    renderConfigsAdmin,
    handleSystemBackup,

    // Category Manager Specific Handlers
    handleCategoryAddInit,
    handleCategoryDelete,
    handleCategoryRenameInit,

    // Country Manager Handlers
    handleCountryAddInit,
    handleCountryDelete,

    // Product Wizard Initiation
    handleProductAddInit,

    // New/Updated Module Functions
    renderAdminMenu,
    renderAdminDashboard,
    renderProductsAdmin,
    renderCategoryManagerMenu,
    renderCountryManagerMenu,
    renderServiceManagerMenu,
    renderServiceSubmenu,
    renderProviderSettingsMenu,
    renderProvidersAdmin,
    renderProductAnalytics,
    renderAdminStats,
    renderAuditLogs,
    handleAdminTextInput,
    productWizard
};
