const { loadDb, saveDb } = require('../utils/database');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Enterprise-grade safe message editor.
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
            logger.error('TELEGRAM_ERROR', `Failed safeEdit in user.js: ${replyErr.message}`, ctx.from?.id);
        }
    }
}

// ==========================================
// 🏠 CORE MAIN KEYBOARD
// ==========================================
function getMainMenu(userId) {
    const settings = loadDb('settings.json');
    const isAdmin = (userId === config.ADMIN_ID || (settings.admins && settings.admins.includes(userId.toString())));

    const buttons = [
        ['📱 Buy Number', '💰 Wallet'],
        ['👤 Profile', '📦 My Orders'],
        ['📥 Deposit', '🎁 Referral'],
        ['⚙ Settings', '🆘 Support']
    ];

    if (isAdmin) {
        buttons.push(['💼 Admin Panel']);
    }

    return {
        keyboard: buttons,
        resize_keyboard: true
    };
}

function handleStart(ctx) {
    try {
        const settings = loadDb('settings.json');
        const welcome = `👋 <b>Welcome to ${settings.bot_name}</b>\n─────────────────────────\n🚀 Premium, instant virtual phone lines for SMS OTP verification and security bypass.\n\n⚡ <b>Core Workflow:</b>\n1️⃣ Tap <b>Buy Number</b> to purchase a line.\n2️⃣ Copy your allocated phone number to the target application.\n3️⃣ Hit <b>Verify & Pull OTP</b> to receive verification codes dynamically.`;
const userId = ctx.from.id.toString();

const users = loadDb('users.json') || {};
const wallets = loadDb('wallet.json') || {};

if (!users[userId]) {

    users[userId] = {
        id: userId,
        username: ctx.from.username || '',
        first_name: ctx.from.first_name || '',
        role: 'User',
        joinedAt: new Date().toISOString()
    };

    saveDb('users.json', users);
}

if (!wallets[userId]) {

    wallets[userId] = {
        balance: 0,
        locked: 0,
        history: []
    };

    saveDb('wallet.json', wallets);
}        
        logger.info('USER_LOGIN', 'User entered bot via /start.', ctx.from.id);
        return ctx.reply(welcome, {
            parse_mode: 'HTML',
            reply_markup: getMainMenu(ctx.from.id)
        });
    } catch (err) {
        logger.error('ERROR', `handleStart crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 👤 MODULE: PROFILE CARD
// ==========================================
function handleProfile(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const wallet = loadDb('wallet.json')[userId] || { balance: 0.0 };
        const orders = loadDb('orders.json').filter(o => o.userId === userId);
        const referrals = loadDb('referrals.json')[userId] || { earnings: { total: 0 } };
        const user = loadDb('users.json')[userId] || {};
        const settings = loadDb('settings.json');
const totalDeposits =
    (wallet.history || [])
    .filter(h => h.type === 'RECHARGE_CREDIT')
    .reduce((a, b) => a + b.amount, 0);

const totalWithdrawals =
    (wallet.history || [])
    .filter(h => h.type === 'WITHDRAWAL_PAID')
    .reduce((a, b) => a + b.amount, 0);

const totalReferral =
    referrals.earnings?.total || 0;

const totalReferred =
    referrals.referredUsers?.length || 0;

const availableReferral =
    referrals.earnings?.total || 0;
        const completed = orders.filter(o => o.status === 'COMPLETED').length;
        const cancelled = orders.filter(o => ['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(o.status)).length;
      
const txt = `
👤 <b>PROFILE DASHBOARD</b>
━━━━━━━━━━━━━━━━━━

👤 Name      : <b>${ctx.from.first_name}</b>
🔑 Username  : @${user.username || 'N/A'}
🆔 User ID   : <code>${userId}</code>

━━━━━━━━━━━━━━━━━━

💰 Balance    : <b>${settings.currency}${wallet.balance.toFixed(2)}</b>
🎁 Referral   : <b>${settings.currency}${availableReferral.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━

📥 Deposit    : <b>${settings.currency}${totalDeposits.toFixed(2)}</b>
📤 Withdrawal : <b>${settings.currency}${totalWithdrawals.toFixed(2)}</b>

👥 Referrals  : <b>${totalReferred}</b>
📦 Orders     : <b>${orders.length}</b>
`;


        logger.info('MENU_ACCESS', 'Accessed user profile card.', userId);
        return safeEdit(ctx, txt, { parse_mode: 'HTML' });
    } catch (err) {
        logger.error('ERROR', `handleProfile crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 📜 MODULE: TRANSACTION HISTORY (PAGINATED)
// ==========================================
function renderTransactionHistory(ctx, page = 0) {
    try {
        const userId = ctx.from.id.toString();
        const wallet = loadDb('wallet.json')[userId] || { history: [] };
        const history = wallet.history || [];
        const settings = loadDb('settings.json');

        const pageSize = 5;
        const totalPages = Math.ceil(history.length / pageSize);
        const startIdx = page * pageSize;
        const endIdx = startIdx + pageSize;
        const pageItems = history.slice(startIdx, endIdx);

        let txt = `📜 <b>TRANSACTION HISTORY (Page ${page + 1}/${totalPages || 1})</b>\n─────────────────────────\n`;

        if (pageItems.length === 0) {
            txt += '<i>No transaction history recorded yet.</i>';
        } else {
            pageItems.forEach((h) => {
                txt += `• <b>[${h.type}]</b> ${settings.currency}${h.amount.toFixed(2)}\n` +
                       `  <i>${h.description}</i>\n` +
                       `  🕒 <code>${new Date(h.timestamp).toLocaleString()}</code>\n\n`;
            });
        }

        const buttons = [];
        if (page > 0) {
            buttons.push({ text: '⬅️ Previous', callback_data: `user_hist_page_${page - 1}` });
        }
        if (endIdx < history.length) {
            buttons.push({ text: '➡️ Next', callback_data: `user_hist_page_${page + 1}` });
        }

        const inlineKeyboard = buttons.length > 0 ? [buttons] : [];

        logger.info('MENU_ACCESS', `Accessed transaction history, page ${page}.`, userId);
        return safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    } catch (err) {
        logger.error('ERROR', `renderTransactionHistory failed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 🆘 MODULE: SUPPORT DESK
// ==========================================
function handleSupport(ctx) {
    try {
        const settings = loadDb('settings.json');
        const txt = `🆘 <b>CUSTOMER SUPPORT DESK</b>\n─────────────────────────\n` +
            `Need help? Our customer support agents are on standby to handle manual deposit reviews, technical inquiries, and SMS gateway issues.\n\n` +
            `💬 Support Admin Handle: <b>@${settings.support_username}</b>\n` +
            `🕒 Operating Hours: <b>24/7/365</b>`;

        const buttons = [
            [{ text: '✉ Contact Support Admin', url: `https://t.me/${settings.support_username}` }],
            [{ text: '❓ View FAQ Details', callback_data: 'user_support_faq' }],
            [{ text: '🚨 Report Platform Issue', callback_data: 'user_support_report' }]
        ];

        logger.info('MENU_ACCESS', 'Accessed Support menu.', ctx.from.id);
        return ctx.reply(txt, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (err) {
        logger.error('ERROR', `handleSupport crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// ⚙ MODULE: PLATFORM SETTINGS
// ==========================================
function handleSettings(ctx) {
    try {
        const settings = loadDb('settings.json');
        const txt = `⚙ <b>USER PREFERENCES PANEL</b>\n─────────────────────────\n` +
            `🌎 Active Language: <b>English (US)</b>\n` +
            `🔔 Status Notifications: <b>Enabled</b>\n` +
            `🎨 UI Theme Setting: <b>Premium Dark Mode</b>\n` +
            `⚙ Version Profile: <b>v1.3.0 Enterprise</b>`;

        const buttons = [
            [{ text: '🌎 Language Setting', callback_data: 'user_set_lang' }],
            [{ text: '🔔 Notifications: ON/OFF', callback_data: 'user_set_notify' }],
            [{ text: '🎨 Switch Theme', callback_data: 'user_set_theme' }]
        ];

        logger.info('MENU_ACCESS', 'Accessed Settings menu.', ctx.from.id);
        return ctx.reply(txt, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (err) {
        logger.error('ERROR', `handleSettings crashed: ${err.message}`, ctx.from?.id);
    }
}

module.exports = {
    handleStart,
    handleProfile,
    handleSupport,
    handleSettings,
    getMainMenu,
    renderTransactionHistory,
    safeEdit
};
