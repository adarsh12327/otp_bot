const db = require('../utils/database');

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

/**
 * Renders the primary settings dashboard dynamically.
 */
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
            [
                { text: `🌍 Language: ${prefs.language}`, callback_data: 'user_set_lang' }
            ],
            [
                { text: `🔔 Notifications: ${prefs.notifications}`, callback_data: 'user_set_notify' }
            ],
            [
                { text: `🎨 Theme: ${prefs.theme}`, callback_data: 'user_set_theme' }
            ],
            [
                { text: '⬅️ Back to Menu', callback_data: 'user_main_menu' }
            ]
        ]
    };

    if (ctx.callbackQuery) {
        return ctx.editMessageText(txt, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
    } else {
        return ctx.reply(txt, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
    }
}

/**
 * Rotational Toggle: English ➡️ Hindi ➡️ Russian ➡️ English
 */
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

/**
 * Rotational Toggle: ENABLED ➡️ DISABLED ➡️ ENABLED
 */
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

/**
 * Rotational Toggle: Dark Premium ➡️ Blue Elegance ➡️ Light Classic ➡️ Dark Premium
 */
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
module.exports = {
    handleSettings,
    handleSetLanguage,
    handleSetNotifications,
    handleSetTheme
};	
