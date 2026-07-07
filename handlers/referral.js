const { loadDb, saveDb } = require('../utils/database');
const security = require('../utils/security');
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
            logger.error('TELEGRAM_ERROR', `Failed safeEdit in referral.js: ${replyErr.message}`, ctx.from?.id);
        }
    }
}

/**
 * Checks if referee (B) has already referred the referrer (A),
 * which would constitute a circular cheat exploit.
 */
function isCircularReferral(referrerId, refereeId) {
    try {
        const referrals = loadDb('referrals.json');
        const refereeRecord = referrals[refereeId];
        if (refereeRecord && refereeRecord.referredUsers) {
            return refereeRecord.referredUsers.some(u => u.userId === referrerId);
        }
        return false;
    } catch (err) {
        logger.error('ERROR', `isCircularReferral check crashed: ${err.message}`);
        return false;
    }
}

/**
 * Verifies if the referee has already registered under any other invitation link.
 */
function isAlreadyReferred(refereeId) {
    try {
        const referrals = loadDb('referrals.json');
        for (const key in referrals) {
            const list = referrals[key].referredUsers || [];
            if (list.some(u => u.userId === refereeId)) return true;
        }
        return false;
    } catch (err) {
        logger.error('ERROR', `isAlreadyReferred check crashed: ${err.message}`);
        return false;
    }
}

// ==========================================
// 🎁 MODULE: REFERRAL PORTAL & LEADERBOARD
// ==========================================
function renderReferralMenu(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const referrals = loadDb('referrals.json')[userId] || { referredUsers: [], earnings: { total: 0, pending: 0, paid: 0 } };
        const settings = loadDb('settings.json');

        const inviteLink = `https://t.me/${ctx.botInfo.username}?start=ref_${userId}`;
        const totalInvites = referrals.referredUsers.length;

        // Calculate active vs pending commissions
        const activeReferralsCount = referrals.referredUsers.filter(u => u.status === 'DEPOSITED').length;
        const paidCommission = referrals.earnings ? referrals.earnings.paid || 0 : 0;
        const totalEarned = referrals.earnings ? referrals.earnings.total || 0 : 0;

        // Fetch and sort global leaderboard (Top 3)
        const allRefs = loadDb('referrals.json');
        const leaderboard = Object.keys(allRefs).map(id => ({
            userId: id,
            earned: allRefs[id].earnings ? allRefs[id].earnings.total || 0 : 0
        })).sort((a, b) => b.earned - a.earned).slice(0, 3);

        let leaderboardTxt = '';
        leaderboard.forEach((item, index) => {
            leaderboardTxt += `🏅 ${index + 1}. User ID <code>${item.userId}</code> - <b>${settings.currency}${item.earned.toFixed(2)}</b>\n`;
        });

const txt =
`🎁 <b>REFERRAL PROGRAM</b>

👥 Total Referrals: <b>${totalInvites}</b>
✅ Active Referrals: <b>${activeReferralsCount}</b>

💰 Referral Earnings: <b>${settings.currency}${totalEarned.toFixed(2)}</b>

🎯 Commission Rate: <b>${settings.referral_percent}%</b> per deposit

🔗 <b>Your Referral Link</b>

<a href="${inviteLink}">${inviteLink}</a>

Invite friends and earn rewards when they complete eligible transactions.`;

        logger.info('REFERRAL_ACCESS', 'Accessed affiliate portal dashboard.', userId);
        return safeEdit(ctx, txt, {
    parse_mode: 'HTML',
    reply_markup: {
        inline_keyboard: [
            [
             
                {
                    text: '📤 Share Link',
                    callback_data: 'ref_share'
                }
            ],
            [
                {
                    text: '🏆 Leaderboard',
                    callback_data: 'ref_leaderboard'
                }
            ]
        ]
    }
});
    } catch (err) {
        logger.error('ERROR', `renderReferralMenu crashed: ${err.message}`, ctx.from?.id);
    }
}

// ==========================================
// 💸 MODULE: COMMISSION PRODUCER & CHEAT RADAR
// ==========================================
async function processReferralCommission(bot, refereeUserId, depositAmount) {
    try {
        const referrals = loadDb('referrals.json');
        const users = loadDb('users.json');
        const settings = loadDb('settings.json');

        let referrerId = null;
        for (const key in referrals) {
            if (referrals[key].referredUsers.some(u => u.userId === refereeUserId)) {
                referrerId = key;
                break;
            }
        }

        if (!referrerId) return; // Not a referred user

        const commission = depositAmount * (settings.referral_percent / 100);
        const refereeObj = users[refereeUserId];
        const referrerObj = users[referrerId];

        // 1. Verify and block circular, self-referral and duplicate checks
        const isSelf = refereeUserId === referrerId;
        const isCircular = isCircularReferral(referrerId, refereeUserId);

        let riskScore = 0;
        const reasons = [];

        if (isSelf) {
            riskScore = 100;
            reasons.push('Self-referral cheat loop');
        }
        if (isCircular) {
            riskScore = 100;
            reasons.push('Circular invite cheat loop');
        }

        // Apply metadata matching checks
        if (refereeObj && referrerObj) {
            const calculatedRisk = security.calculateRiskScore(refereeObj, referrerObj);
            riskScore = Math.max(riskScore, calculatedRisk.score);
            calculatedRisk.reasons.forEach(r => {
                if (!reasons.includes(r)) reasons.push(r);
            });
        }

        // 2. High Risk Isolation routing (Manual Review Queue)
        if (riskScore >= 40) {
            const flagged = loadDb('flaggedReferrals.json');
            const flagId = 'flag_' + Math.random().toString(36).substring(2, 9);

            flagged.push({
                id: flagId,
                referrerId,
                refereeId: refereeUserId,
                refereeName: refereeObj ? refereeObj.first_name : 'N/A',
                amount: commission,
                timestamp: new Date().toISOString(),
                score: riskScore,
                reasons: reasons
            });
            saveDb('flaggedReferrals.json', flagged);

            logger.warn('FRAUD', `Fraud Alert: High risk commission flagged for user ID ${referrerId} - Score: ${riskScore}`, referrerId);

            // Alert administrative logs
            bot.telegram.sendMessage(config.ADMIN_ID, `⚠️ <b>FRAUD RADAR: SUSPICIOUS COMMISSION ALERT</b>\n─────────────────────────\n👤 Referrer Account ID: <code>${referrerId}</code>\n👥 Referee Account ID: <code>${refereeUserId}</code>\n💰 Potential Commission: <b>${settings.currency}${commission.toFixed(2)}</b>\n🚨 Fraud Risk Index: <b>${riskScore}/100</b>\n📝 Trigger Alerts: <i>${reasons.join(', ')}</i>\n\nPayout was automatically locked and routed to the <b>Fraud Center</b>.`, { parse_mode: 'HTML' }).catch(() => {});
            return;
        }

        // 3. Clear Commission Payout Process
        const wallets = loadDb('wallet.json');
        const refWallet = wallets[referrerId];

        if (refWallet) {
            refWallet.balance += commission;
            refWallet.history.push({
                type: 'REFERRAL_COMMISSION',
                amount: commission,
                timestamp: new Date().toISOString(),
                description: `Affiliate bonus from referee registration ID ${refereeUserId}`
            });
            wallets[referrerId] = refWallet;
            saveDb('wallet.json', wallets);

            // Update referrals ledger database
            const refData = referrals[referrerId];
            refData.earnings = refData.earnings || { total: 0, pending: 0, paid: 0 };
            refData.earnings.total += commission;
            refData.earnings.paid += commission;

            const uIdx = refData.referredUsers.findIndex(u => u.userId === refereeUserId);
            if (uIdx !== -1) {
                refData.referredUsers[uIdx].status = 'DEPOSITED';
                refData.referredUsers[uIdx].earned = commission;
            }
            referrals[referrerId] = refData;
            saveDb('referrals.json', referrals);

            logger.info('REFERRAL_PAYOUT', `Commission payout ₹${commission} paid to referrer ID ${referrerId}`, refereeUserId);
            
            bot.telegram.sendMessage(referrerId, `🎁 <b>REFERRAL BONUS CREDITED!</b>\n─────────────────────────\n👥 Referral deposit of: ${settings.currency}${depositAmount.toFixed(2)}\n💰 Your ${settings.referral_percent}% Share: <b>${settings.currency}${commission.toFixed(2)}</b>\n\nYour balance is instantly updated.`, { parse_mode: 'HTML' }).catch(() => {});
        }
    } catch (err) {
        logger.error('ERROR', `processReferralCommission crashed: ${err.message}`);
    }
}

module.exports = {
    renderReferralMenu,
    processReferralCommission,
    isCircularReferral,
    isAlreadyReferred
};
