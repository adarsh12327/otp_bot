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
            logger.error('TELEGRAM_ERROR', `Failed safeEdit in wallet.js: ${replyErr.message}`, ctx.from?.id);
        }
    }
}

/**
 * Scans both active pending queue deposits and historical ledger descriptions
 * to verify if a transaction UTR code has already been registered inside the system.
 */
function isUtrDuplicate(utr) {
    try {
        const settings = loadDb('settings.json');
        const pending = settings.pending_payments || [];
        if (pending.some(p => p.utr === utr)) return true;

        const wallets = loadDb('wallet.json');
        for (const uid in wallets) {
            const history = wallets[uid].history || [];
            if (history.some(h => h.description && h.description.includes(utr))) {
                return true;
            }
        }
        return false;
    } catch (err) {
        logger.error('ERROR', `isUtrDuplicate check crashed: ${err.message}`);
        return false;
    }
}

/**
 * Calculates and aggregates user wallet statistics dynamically from 
 * database transactions, active order queues, and historical payment ledgers.
 */
function getWalletStats(userId) {
    try {
        const wallets = loadDb('wallet.json');
        const orders = loadDb('orders.json');
        const settings = loadDb('settings.json');

        const w = wallets[userId] || { balance: 0.0, locked: false, history: [] };
        const history = w.history || [];

        let availableBalance = w.balance;
        
        // Locked balance calculated dynamically from ongoing active wait order prices
        let lockedBalance = w.locked 
            ? history.filter(h => h.type === 'DEBIT_PURCHASE').slice(-1).reduce((acc, curr) => acc + curr.amount, 0) 
            : 0.0;

        let pendingBalance = (settings.pending_payments || [])
            .filter(p => p.userId === userId)
            .reduce((acc, curr) => acc + curr.amount, 0);

const referrals =
    loadDb('referrals.json') || {};

const refData =
    referrals[userId] || {
        earnings: {
            total: 0
        }
    };

let referralBalance =
    Number(refData.earnings?.total || 0);
        let bonusBalance = history
            .filter(h => h.type === 'BONUS')
            .reduce((acc, curr) => acc + curr.amount, 0);

        let lifetimeDeposit = history
            .filter(h => h.type === 'RECHARGE_CREDIT')
            .reduce((acc, curr) => acc + curr.amount, 0);

        let lifetimeWithdraw = history
            .filter(h => h.type === 'WITHDRAWAL_PAID')
            .reduce((acc, curr) => acc + curr.amount, 0);

        const userOrders = orders.filter(o => o.userId === userId);
        let totalPurchases = userOrders.filter(o => o.status === 'COMPLETED').reduce((acc, curr) => acc + curr.price, 0);
        let totalRefunds = history.filter(h => h.type === 'REFUND').reduce((acc, curr) => acc + curr.amount, 0);

        return {
            availableBalance,
            lockedBalance,
            pendingBalance,
            referralBalance,
            bonusBalance,
            lifetimeDeposit,
            lifetimeWithdraw,
            totalPurchases,
            totalRefunds
        };
    } catch (err) {
        logger.error('ERROR', `getWalletStats failed: ${err.message}`, userId);
        return {
            availableBalance: 0.0, lockedBalance: 0.0, pendingBalance: 0.0,
            referralBalance: 0.0, bonusBalance: 0.0, lifetimeDeposit: 0.0,
            lifetimeWithdraw: 0.0, totalPurchases: 0.0, totalRefunds: 0.0
        };
    }
}

// ==========================================
// 💰 MODULE: WALLET CORE MENU
// ==========================================
function renderWalletMenu(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const stats = getWalletStats(userId);
        const settings = loadDb('settings.json');

       const txt =
`💼 <b>WALLET</b>

━━━━━━━━━━━━━━

💰 <b>AVAILABLE BALANCE</b>
<b>${settings.currency}${stats.availableBalance.toFixed(2)}</b>

━━━━━━━━━━━━━━

📥 Deposited: <b>${settings.currency}${stats.lifetimeDeposit.toFixed(2)}</b>
🎁 Referral: <b>${settings.currency}${stats.referralBalance.toFixed(2)}</b>

Select an option below:`;

 const buttons = [
    [
        { text: '💳 Deposit', callback_data: 'wallet_deposit_init' }
    ],
    [
        { text: '💸 Withdraw', callback_data: 'wallet_withdraw_init' }
    ],
    [
        { text: '📜 History', callback_data: 'wallet_history' }
    ]
];

        logger.info('WALLET_ACCESS', 'Accessed wallet ledger dashboard.', userId);
        return safeEdit(ctx, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
        logger.error('ERROR', `renderWalletMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 📥 MODULE: DEPOSIT RECHARGE WIZARD
// ==========================================
function handleDepositInit(ctx) {
    try {
        const settings = loadDb('settings.json');
        ctx.session.step = 'W_DEPOSIT_AMT';
        
        logger.info('RECHARGE_REQUEST', 'Initiated manual deposit sequence.', ctx.from.id);
        return safeEdit(ctx, `💵 <b>MANUAL RECHARGE DISPATCH</b>\n─────────────────────────\nEnter recharge deposit amount in <b>${settings.currency}</b> (Min: ${settings.currency}${settings.min_recharge}, Max: ${settings.currency}${settings.max_recharge}):`, { parse_mode: 'HTML' });
    } catch (err) {
        logger.error('ERROR', `handleDepositInit failed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 📤 MODULE: PAYOUT WITHDRAWAL WIZARD
// ==========================================
function handleWithdrawInit(ctx) {
    try {
        const settings = loadDb('settings.json');
        ctx.session.step = 'W_WITHDRAW_AMT';
        
        logger.info('WITHDRAWAL_REQUEST', 'Initiated manual withdrawal sequence.', ctx.from.id);
const referrals =
    loadDb('referrals.json') || {};

const refData =
    referrals[ctx.from.id.toString()] || {
        earnings: {
            total: 0
        }
    };

const referralBalance =
    Number(refData.earnings?.total || 0);

return safeEdit(
    ctx,
`📤 <b>REFERRAL WITHDRAWAL</b>
─────────────────────────

💰 Available Referral Balance:
<b>${settings.currency}${referralBalance.toFixed(2)}</b>

📌 Withdrawal Rules

• Only referral earnings can be withdrawn
• Minimum withdrawal amount: ${settings.currency}20
• Wallet balance cannot be withdrawn
• Manual admin approval required

📝 Enter withdrawal amount:`,
{
    parse_mode: 'HTML'
});

    } catch (err) {
        logger.error('ERROR', `handleWithdrawInit failed: ${err.message}`, ctx.from?.id);
    }
}

module.exports = {
    renderWalletMenu,
    handleDepositInit,
    handleWithdrawInit,
    isUtrDuplicate,
    getWalletStats
};
