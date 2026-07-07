const { loadDb, saveDb } = require('../utils/database');
const providerService = require('../services/providerService');
const logger = require('../utils/logger');
const config = require('../config');
const { Telegram } = require('telegraf');

// Initialize Telegram API instance
const botToken = config.botToken || config.telegramToken || config.token || config.BOT_TOKEN || process.env.BOT_TOKEN || '';
const telegram = new Telegram(botToken);

/**
 * Safe message editor.
 * Gracefully downgrades or replies if message editing triggers mismatches.
 */
async function safeEdit(ctx, text, extra = {}) {
    try {
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            if (ctx.session) {
                ctx.session.lastMenuId = ctx.callbackQuery.message.message_id;
            }

            return await ctx.editMessageText(text, extra);
        }

        if (ctx.session && ctx.session.lastMenuId) {
            try {
                return await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    ctx.session.lastMenuId,
                    null,
                    text,
                    extra
                );
            } catch (editErr) {
                const res = await ctx.reply(text, extra);

                if (ctx.session) {
                    ctx.session.lastMenuId = res.message_id;
                }

                return res;
            }
        }

        const res = await ctx.reply(text, extra);

        if (ctx.session) {
            ctx.session.lastMenuId = res.message_id;
        }

        return res;

    } catch (err) {
        try {
            const res = await ctx.reply(text, extra);

            if (ctx.session) {
                ctx.session.lastMenuId = res.message_id;
            }

            return res;
        } catch (replyErr) {
            logger.error(
                'TELEGRAM_ERROR',
                `Failed safeEdit in order.js: ${replyErr.message}`,
                ctx.from?.id
            );
        }
    }
}

//////////Loding diloge//////////////
async function showLoading(ctx) {

    const steps = [5, 18, 36, 57, 79, 100];

    for (const percent of steps) {

        const filled = Math.floor(percent / 10);

        const bar =
            "█".repeat(filled) +
            "░".repeat(10 - filled);

        try {

            await ctx.editMessageText(
                `⚡ <b>Please Wait...</b>\n\n` +
                `<code>${bar}</code> ${percent}%`,
                {
                    parse_mode: "HTML"
                }
            );

        } catch (e) {}

        await new Promise(r => setTimeout(r, 400));

    }

}

/**
 * Safe Settings Loader (With INR Override)
 */
function getSettings() {
    try {
        const settings = loadDb('settings.json');
        if (settings && settings.currency === '$') {
            settings.currency = '₹';
        }
        return settings;
    } catch (err) {
        logger.warn(
            'SETTINGS_WARNING',
            'settings.json missing, using fallback settings'
        );

        return {
            currency: '₹',
            order_timeout: 600
        };
    }
}

/**
 * Pricing Engine: Converts USDT/USD provider cost to INR
 */
function getCalculatedPrice(
    providerCost,
    markupPercent = 20,
    markupFlat = 1.0
) {
    let USD_TO_INR = 105;

    try {
        const settings = getSettings();

        if (settings && settings.usd_to_inr !== undefined) {
            const parsed = Number(settings.usd_to_inr);

            if (!isNaN(parsed)) {
                USD_TO_INR = parsed;
            }
        }
    } catch (err) {}

    const costInINR = providerCost * USD_TO_INR;

    const profitPercent = Number(
        getSettings().profit_percent || 10
    );

    const finalCost =
        costInINR * (1 + profitPercent / 100);

    return Number(finalCost.toFixed(2));
}

/**
 * Safe Products Loader
 */
function getProducts() {
    try {
        const data = loadDb('products.json');
        return Array.isArray(data) ? data : [];
    } catch (err) {
        logger.warn(
            'PRODUCTS_WARNING',
            'Failed to load products.json'
        );

        return [];
    }
}

/**
 * Safe Services Loader
 */
function getServicesDb() {
    try {
        const data = loadDb('services_db.json');
        return Array.isArray(data) ? data : [];
    } catch (err) {
        logger.warn(
            'SERVICES_WARNING',
            'Failed to load services_db.json'
        );

        return [];
    }
}

/**
 * Shared Helper: Format Live Order Messages in INR
 */
function getFormattedOrderText(order, settings) {
    const elapsed = Math.floor((Date.now() - order.timestamp) / 1000);
    const timeoutSeconds = Number(settings.order_timeout || 600);
    const remainingTimeout = Math.max(0, timeoutSeconds - elapsed);
    
    const timeoutMin = String(Math.floor(remainingTimeout / 60)).padStart(2, '0');
    const timeoutSec = String(remainingTimeout % 60).padStart(2, '0');
    const timeoutStr = `${timeoutMin}:${timeoutSec}`;
let cancelRemaining = Math.max(
    0,
    300 - elapsed
);


const cancelMin = String(
    Math.floor(cancelRemaining / 60)
).padStart(2, '0');

const cancelSec = String(
    cancelRemaining % 60
).padStart(2, '0');

const cancelStr = `${cancelMin}:${cancelSec}`;

    const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');
    const finalCost = Number(order.price || 0).toFixed(2);

    return `📱 <b>NUMBER PURCHASED</b>
─────────────────────────

📦 Service:
<b>${order.productName || 'Unknown Service'}</b>

🌍 Country:
<b>${order.productCountry || 'Unknown Country'}</b>

📞 Number:
<code>${order.number}</code>

💰 Cost:
<b>${currency}${finalCost}</b>

⏳ Timeout: <b>${timeoutStr}</b>
❌ Cancel Available In: <b>${cancelStr}</b>

🕒 Status:
<i>Waiting for OTP...</i>`;
}

// ==========================================
// 📱 MODULE: RENDER BUY SERVICE MENU
// ==========================================
async function renderBuyMenu(ctx) {
    try {
        await providerService.checkLazySync();

        if (ctx.session) {
            ctx.session.awaitingSearch = false;
        }

        const txt =
`📱 <b>BUY NUMBER</b>
─────────────────────────

Welcome to the SMS Marketplace.

Please choose an option below to continue:`;

        const buttons = [
            [
                {
                    text: '🔥 Popular Services',
                    callback_data: 'buy_popular'
                }
            ],
            [
                {
                    text: '📂 Browse Categories',
                    callback_data: 'buy_categories'
                }
            ],
            [
                {
                    text: '🔍 Smart Search',
                    callback_data: 'buy_search'
                }
            ],
            [
                {
                    text: '🆕 Recently Added',
                    callback_data: 'buy_recent'
                }
            ],
            [
                {
                    text: '⭐ Favorites',
                    callback_data: 'buy_favorites'
                }
            ]
        ];
        
        return await safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `renderBuyMenu crashed: ${err.message}`,
            ctx.from?.id
        );

        return await safeEdit(
            ctx,
            '❌ Failed to load Buy Menu.'
        );
    }
}

// ==========================================
// 🔥 MODULE: POPULAR SERVICES
// ==========================================
async function renderPopularMenu(ctx) {
    try {
        const products = getProducts();
        const servicesDb = getServicesDb();
        const settings = getSettings();

        const filtered = products.filter(
            p => p && p.status === 'active' && p.popular
        );

        if (!filtered.length) {
            return await safeEdit(
                ctx,
                '🔥 <b>Popular Services</b>\n\nNo popular products available.',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Back', callback_data: 'buy_menu' }]
                        ]
                    }
                }
            );
        }

        let txt = `📱 <b>Select Service</b>`;

        const buttons = [];

        for (const p of filtered) {
            const providerCost = Number(p.price || 0);

            const displayPrice = getCalculatedPrice(providerCost);
            const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

            buttons.push([
                {
                    text:
                        `${p.emoji || '📱'} ${p.name} - ${p.country}` +
                        ` (${currency}${displayPrice.toFixed(2)})`,
                    callback_data: `buy_prod_${p.id}`
                }
            ]);
        }

        buttons.push([
            {
                text: '⬅️ Back to Buy Menu',
                callback_data: 'buy_menu'
            }
        ]);
          return await safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `renderPopularMenu crashed: ${err.message}`,
            ctx.from?.id
        );

        return await safeEdit(
            ctx,
            '❌ Failed to load popular services.'
        );
    }
}

// ==========================================
// 📂 MODULE: BROWSE CATEGORIES
// ==========================================
async function renderCategoryMenu(ctx) {
    try {
         let categories = [];

        try {
            categories = loadDb('categories.json');
        } catch (err) {
            logger.warn(
                'CATEGORY_WARNING',
                'categories.json missing, using fallback categories'
            );
        }

        let finalCategories =
            Array.isArray(categories)
                ? categories
                : [];

        if (!finalCategories.length) {
            finalCategories = [
                'Social',
                'Email',
                'Gaming',
                'Shopping',
                'Finance',
                'Others'
            ];
        }

        const buttons = finalCategories.map(cat => [
            {
                text: `📁 ${cat}`,
                callback_data: `cat_${cat.toLowerCase()}`
            }
        ]);

        buttons.push([
            {
                text: '⬅️ Back',
                callback_data: 'buy_menu'
            }
        ]);
        return await safeEdit(
            ctx,
            `📂 <b>Select Dynamic Category</b>
─────────────────────────
Browse services by dynamic groupings:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );

    } catch (err) {
        logger.error(
            'ERROR',
            `renderCategoryMenu crashed: ${err.message}`,
            ctx.from?.id
        );

        return await safeEdit(
            ctx,
            '❌ Failed to load categories.'
        );
    }
}

// ==========================================
// 📦 MODULE: CATEGORY PRODUCTS
// ==========================================
async function renderCategoryProducts(ctx, category) {
    try {
        const products = getProducts();
        const servicesDb = getServicesDb();
        const settings = getSettings();

        const filtered = products.filter(
            p =>
                p &&
                p.status === 'active' &&
                (p.category || '').toLowerCase() ===
                (category || '').toLowerCase()
        );

        if (!filtered.length) {
            return await safeEdit(
                ctx,
                `❌ No active products found in "${category}".`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ Back to Categories',
                                    callback_data:
                                        'buy_categories'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        let txt = `📱 <b>Select Service</b>`;

        const buttons = [];

        for (const p of filtered) {
            const rates =
                await providerService
                    .getBestProviderAndPrice(
                        p.code,
                        p.countryCode
                    )
                    .catch(() => []);

            let providerCost = Number(p.price || 0);

            if (Array.isArray(rates) && rates.length) {
                const best = rates[0];
                providerCost = Number(best.price !== undefined ? best.price : (best.cost !== undefined ? best.cost : p.price || 0));
            }

            const displayPrice = getCalculatedPrice(providerCost);
            const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

            buttons.push([
                {
                    text:
                        `${p.emoji || '📱'} ${p.name} - ${p.country}` +
                        ` (${currency}${displayPrice.toFixed(2)})`,
                    callback_data: `buy_prod_${p.id}`
                }
            ]);
        }

        buttons.push([
            {
                text: '⬅ Back to Categories',
                callback_data: 'buy_categories'
            }
        ]);

        return await safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `renderCategoryProducts crashed: ${err.message}`,
            ctx.from?.id
        );
        return await safeEdit(
            ctx,
            '❌ Failed to load category products.'
        );
    }
}
// ==========================================
// 📦 MODULE: PRODUCT DETAILS
// ==========================================
async function renderProductDetails(ctx, productId) {
    try {
       const products = getProducts();
        const settings = getSettings();

        const product = products.find(
            p => p && p.id === productId
        );

        if (!product) {
            return await safeEdit(
                ctx,
                '❌ Product not found.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ Back',
                                    callback_data: 'buy_menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        const rates =
            await providerService
                .getBestProviderAndPrice(
                    product.code,
                    product.countryCode
                )
                .catch(() => []);

        let providerCost = Number(product.price || 0);

        if (Array.isArray(rates) && rates.length) {
            const best = rates[0];
            providerCost = Number(
                best.price ??
                best.cost ??
                product.price
            );
        }

        const finalPrice =
            getCalculatedPrice(providerCost);

        const currency =
            settings.currency === '$'
                ? '₹'
                : settings.currency || '₹';

        const txt = `
📦 <b>${product.name}</b>
────────────────────────

🌍 Country:
<b>${product.country}</b>

💰 Price:
<b>${currency}${finalPrice.toFixed(2)}</b>

📝 Description:
${product.description || "No description available"}
Select an option below.
`;

const favorites = loadDb('favorites.json') || {};
const userId = String(ctx.from.id);

const isFavorite =
    (favorites[userId] || []).includes(product.id);
        return await safeEdit(
            ctx,
            txt,
            {
                parse_mode: 'HTML',
                reply_markup: {
inline_keyboard: [
    [
        {
            text: '✅ Buy Number',
            callback_data: `confirm_buy_${product.id}`
        }
    ],
    [
        {
            text: isFavorite
    ? '❌ Remove Favorite'
    : '⭐ Add Favorite',
       callback_data: isFavorite
    ? `fav_remove_${product.id}`
    : `fav_add_${product.id}`
        }
    ],
    [
        {
            text: '⬅️ Back',
            callback_data: 'buy_menu'
        }
    ]
]
                }
            }
        );

    } catch (err) {
        logger.error(
            'ERROR',
            `renderProductDetails: ${err.message}`
        );
        return safeEdit(
            ctx,
            '❌ Failed to load product.'
        );
    }
}
// ==========================================
// 🔍 MODULE: SMART SEARCH
// ==========================================
async function renderSearchMenu(ctx) {
    try {

         if (ctx.session) {
            ctx.session.awaitingSearch = true;
        }
        return await safeEdit(
            ctx,
            `🔍 <b>Smart Search</b>
─────────────────────────
Enter product name or service code.

Examples:
<code>Telegram</code>
<code>tg</code>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back to Menu',
                                callback_data: 'buy_menu'
                            }
                        ]
                    ]
                }
            }
        );
    } catch (err) {
        logger.error(
            'ERROR',
            `renderSearchMenu crashed: ${err.message}`,
            ctx.from?.id
        );
    }
}

// ==========================================
// 🔍 MODULE: SEARCH RESULTS
// ==========================================
async function renderSearchResults(ctx, query) {
    try {
        const products = getProducts();
        const servicesDb = getServicesDb();
        const settings = getSettings();

        const searchQuery = (query || '').trim().toLowerCase();

        const filtered = products.filter(
            p =>
                p &&
                p.status === 'active' &&
                (
                    (p.name || '')
                        .toLowerCase()
                        .includes(searchQuery) ||
                    (p.code || '')
                        .toLowerCase() === searchQuery
                )
        );

        if (!filtered.length) {
            return await safeEdit(
                ctx,
                `❌ No active products found matching "<b>${query}</b>".`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🔍 Try Another Search',
                                    callback_data: 'buy_search'
                                }
                            ],
                            [
                                {
                                    text: '⬅️ Back to Buy Menu',
                                    callback_data: 'buy_menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        let txt = `📱 <b>Select Service</b>`;

        const buttons = [];

        for (const p of filtered) {
            const rates =
                await providerService
                    .getBestProviderAndPrice(
                        p.code,
                        p.countryCode
                    )
                    .catch(() => []);

            let providerCost = Number(p.price || 0);

            if (Array.isArray(rates) && rates.length) {
                const best = rates[0];
                providerCost = Number(best.price !== undefined ? best.price : (best.cost !== undefined ? best.cost : p.price || 0));
            }

            const displayPrice = getCalculatedPrice(providerCost);
            const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

            buttons.push([
                {
                    text:
                        `${p.emoji || '📱'} ${p.name} - ${p.country}` +
                        ` (${currency}${displayPrice.toFixed(2)})`,
                    callback_data: `buy_prod_${p.id}`
                }
            ]);
        }

        buttons.push([
            {
                text: '⬅ Back to Search',
                callback_data: 'buy_search'
            }
        ]);
        return await safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `renderSearchResults crashed: ${err.message}`,
            ctx.from?.id
        );
        return await safeEdit(
            ctx,
            '❌ Failed to load search results.'
        );
    }
}

// ==========================================
// 🔍 MODULE: SEARCH INPUT HANDLER
// ==========================================
async function handleSearchInput(ctx) {
    try {
           if (
            !ctx.session ||
            !ctx.session.awaitingSearch
        ) {
            return;
        }

        ctx.session.awaitingSearch = false;

        const query =
            ctx.message?.text?.trim() || '';

        if (!query) {
            return await safeEdit(
                ctx,
                '❌ Please enter a valid search term.'
            );
        }

        await ctx
            .deleteMessage()
            .catch(() => {});

        return await renderSearchResults(
            ctx,
            query
        );

    } catch (err) {
        logger.error(
            'ERROR',
            `handleSearchInput crashed: ${err.message}`,
            ctx.from?.id
        );
    }
}

// ==========================================
// 🆕 MODULE: RECENTLY ADDED
// ==========================================
async function renderRecentMenu(ctx) {
    try {
         const products = getProducts();
        const servicesDb = getServicesDb();
        const settings = getSettings();

        const activeProducts =
            products.filter(
                p => p && p.status === 'active'
            );

        const recentProducts =
            activeProducts
                .slice(-5)
                .reverse();

        if (!recentProducts.length) {
           return await safeEdit(
                ctx,
                `🆕 <b>Recently Added</b>

No active products listing found.`,
{
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ Back',
                                    callback_data: 'buy_menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        let txt = `📱 <b>Select Service</b>`;

        const buttons = [];

        for (const p of recentProducts) {
            const rates =
                await providerService
                    .getBestProviderAndPrice(
                        p.code,
                        p.countryCode
                    )
                    .catch(() => []);

            let providerCost = Number(p.price || 0);

            if (Array.isArray(rates) && rates.length) {
                const best = rates[0];
                providerCost = Number(best.price !== undefined ? best.price : (best.cost !== undefined ? best.cost : p.price || 0));
            }

            const displayPrice = getCalculatedPrice(providerCost);
            const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

            buttons.push([
                {
                    text:
                        `${p.emoji || '📱'} ${p.name} - ${p.country}` +
                        ` (${currency}${displayPrice.toFixed(2)})`,
                    callback_data: `buy_prod_${p.id}`
                }
            ]);
        }

        buttons.push([
            {
                text: '⬅ Back to Buy Menu',
                callback_data: 'buy_menu'
            }
        ]);
        return await safeEdit(ctx, txt, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

    } catch (err) {
        logger.error(
            'ERROR',
            `renderRecentMenu crashed: ${err.message}`,
            ctx.from?.id
        );

        return await safeEdit(
            ctx,
            '❌ Failed to load recently added services.'
        );
    }
}

// ==========================================
// ⭐ MODULE: FAVORITES
// ==========================================
async function renderFavoritesMenu(ctx) {
    try {
        const userId = String(ctx.from.id);

        const favorites = loadDb('favorites.json') || {};
        const products = getProducts();
        const settings = getSettings();

        const favIds = favorites[userId] || [];

        if (!favIds.length) {
            return await safeEdit(
                ctx,
                '⭐ <b>Favorites</b>\n\nNo favorite services yet.',
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ Back',
                                    callback_data: 'buy_menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        const buttons = [];
        let txt = '⭐ <b>Your Favorite Services</b>\n\n';

        for (const id of favIds) {
            const p = products.find(x => String(x.id) === String(id));

            if (p) {
            const rates = await providerService
    .getBestProviderAndPrice(
        p.code,
        p.countryCode
    )
    .catch(() => []);

let providerCost = Number(p.price || 0);

if (Array.isArray(rates) && rates.length) {
    const best = rates[0];
    providerCost = Number(
        best.price !== undefined
            ? best.price
            : (
                best.cost !== undefined
                    ? best.cost
                    : p.price
             )
         );
     }

     const finalPrice = getCalculatedPrice(providerCost);

          const currency =
    settings.currency === '$'
        ? '₹'
        : (settings.currency || '₹');



                buttons.push([
                    {
                        text: `${p.emoji || "📦"} ${p.name} • ${p.country} • ${currency}${finalPrice.toFixed(2)}`,
                       callback_data: `buy_prod_${p.id}`
                    }
                ]);
            }
        }

        buttons.push([
            {
                text: '⬅️ Back',
                callback_data: 'buy_menu'
            }
        ]);
      return await safeEdit(
    ctx,
    '⭐ <b>Favorites</b>',

           {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );

    } catch (err) {
        logger.error('ERROR', `renderFavoritesMenu: ${err.message}`);

        return safeEdit(ctx, '❌ Failed to load favorites.');
    }
}

// ==========================================
// 📦 MODULE: ORDER LIFECYCLE CREATION
// ==========================================
async function handleBuyProduct(ctx, productId) {
    const userId = String(ctx.from.id);

    try {
        const products = getProducts();
        const settings = getSettings();
        const servicesDb = getServicesDb();

        const product = products.find(
            p => p && p.id === productId
        );

        if (!product) {
            return ctx.answerCbQuery(
                '❌ Product not found.'
            );
        }

        const wallets = loadDb('wallet.json');

        const userWallet =
            wallets[userId] || {
                balance: 0,
                locked: false,
                history: []
            };

        // ==================================
        // DOUBLE SPEND PROTECTION
        // ==================================
        if (userWallet.locked) {
            return ctx.answerCbQuery(
                '⚠️ Order already in progress.',
                {
                    show_alert: true
                }
            );
        }

        // ==================================
        // GET BEST PROVIDERS
        // ==================================
        const candidates =
            await providerService
                .getBestProviderAndPrice(
                    product.code,
                    product.countryCode
                )
                .catch(() => []);

        if (!Array.isArray(candidates) || !candidates.length) {
            return ctx.answerCbQuery(
                '❌ Service out of stock.',
                {
                    show_alert: true
                }
            );
        }

        const cheapest = candidates[0];
        let providerCost = Number(cheapest.price !== undefined ? cheapest.price : (cheapest.cost !== undefined ? cheapest.cost : product.price || 0));

        // Convert provider cost to INR
        const finalCost = getCalculatedPrice(providerCost);
        const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

        // ==================================
        // BALANCE CHECK
        // ==================================
        if (userWallet.balance < finalCost) {
            return ctx.answerCbQuery(
                `❌ Insufficient balance.\nNeed ${currency}${finalCost.toFixed(2)}`,
                {
                    show_alert: true
                }
            );
        }

        // ==================================
        // LOCK USER
        // ==================================
        userWallet.locked = true;

        wallets[userId] = userWallet;

        saveDb(
            'wallet.json',
            wallets
        );

        await ctx.answerCbQuery(
            '🔄 Finding best provider...'
        );

        // ==================================
        // SMART ROUTING
        // ==================================
        let allocation = null;
        let selectedProvider = null;

        for (const candidate of candidates) {
            try {
                const result =
                    await providerService.allocateLine(
                        candidate.providerKey,
                        product.code,
                        product.countryCode
                    );

                if (result) {
                    allocation = result;
                    selectedProvider =
                        candidate.providerKey;
                    break;
                }
            } catch (err) {
                logger.warn(
                    'PROVIDER_FAIL',
                    `${candidate.providerKey} failed: ${err.message}`,
                    userId
                );
            }
        }

        // ==================================
        // NO PROVIDER SUCCESS
        // ==================================
        if (!allocation) {
            userWallet.locked = false;

            wallets[userId] = userWallet;

            saveDb(
                'wallet.json',
                wallets
            );

            return await safeEdit(
                ctx,
                `❌ <b>Gateway allocation failed.</b>

Please try again later.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ Back',
                                    callback_data:
                                        'buy_menu'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        // ==================================
        // CREATE ORDER
        // ==================================
        let orders = [];

        try {
            orders =
                loadDb('orders.json');
        } catch {
            orders = [];
        }

        const orderId =
            'ord_' +
            Math.random()
                .toString(36)
                .substring(2, 9);

        const newOrder = {
            id: orderId,
            userId,
            productId,
            productName: product.name,
            productCountry: product.country || 'Unknown',
            price: finalCost,
            number: allocation.number,
            providerOrderId:
                allocation.providerId,
            providerSysId:
                allocation.providerSysId,
                        activationTime:
                allocation.activationTime || null,
            activationCancel:
                allocation.activationCancel || null,
            activationEnd:
                allocation.activationEnd || null,
            providerCost:
                allocation.providerCost || 0,
            status: 'WAITING',
            otp: null,
            timestamp: Date.now(),
            chatId: String(ctx.chat.id),
            messageId: null
        };

        orders.push(newOrder);

        saveDb(
            'orders.json',
            orders
        );

        // ==================================
        // DEBIT USER
        // ==================================
        userWallet.balance -= finalCost;

        userWallet.locked = false;

        userWallet.history.push({
            type: 'DEBIT_PURCHASE',
            amount: finalCost,
            timestamp:
                new Date().toISOString(),
            description:
                `Purchased ${product.name} (${product.country})`
        });

        wallets[userId] = userWallet;

        saveDb(
            'wallet.json',
            wallets
        );

        logger.info(
            'ORDER_CREATED',
            `Order ${orderId} created`,
            userId
        );

        const initialText = getFormattedOrderText(newOrder, settings);
        const initialButtons = [
            [
                {
                    text: '🔄 Check OTP',
                    callback_data: `order_check_${orderId}`
                }
            ],
            [
                {
                   text: `🔒 Cancel Locked (05:00)`,
                    callback_data: `order_cancel_${orderId}`
                }
            ]
        ];

        const editRes = await safeEdit(
            ctx,
            initialText,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: initialButtons
                }
            }
        );

        // Extract and Save message ID
        let msgId = null;
        if (editRes && editRes.message_id) {
            msgId = editRes.message_id;
        } else if (ctx.callbackQuery && ctx.callbackQuery.message) {
            msgId = ctx.callbackQuery.message.message_id;
        } else if (ctx.session && ctx.session.lastMenuId) {
            msgId = ctx.session.lastMenuId;
        }

        if (msgId) {
            try {
                const currentOrders = loadDb('orders.json');
                const idx = currentOrders.findIndex(o => o.id === orderId);
                if (idx !== -1) {
                    currentOrders[idx].messageId = String(msgId);
                    saveDb('orders.json', currentOrders);
                }
            } catch (err) {
                logger.error('ERROR', `Failed to update order messageId: ${err.message}`);
            }
        }

        return editRes;

    } catch (err) {
        try {
            const wallets =
                loadDb('wallet.json');

            if (wallets[userId]) {
                wallets[userId].locked = false;

                saveDb(
                    'wallet.json',
                    wallets
                );
            }
        } catch {}

        logger.error(
            'ERROR',
            `handleBuyProduct crashed: ${err.message}`,
            userId
        );

        return await safeEdit(
            ctx,
            `❌ <b>Purchase failed.</b>

Please try again.`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Back',
                                callback_data:
                                    'buy_menu'
                            }
                        ]
                    ]
                }
            }
        );
    }
}
// ==========================================
// 🔄 MODULE: OTP SYSTEM POLLING
// ==========================================
async function handleCheckOTP(ctx, orderId) {
    try {
        const orders = loadDb('orders.json');
        const orderIndex = orders.findIndex(
            o => o.id === orderId
        );

        const settings = getSettings();

        if (orderIndex === -1) {
            return ctx.answerCbQuery(
                '❌ Order not found.'
            );
        }

        const order = orders[orderIndex];

        if (order.status !== 'WAITING') {
            return ctx.answerCbQuery(
                `Status: ${order.status}`
            );
        }

        const state =
            await providerService.checkStatus(
                order.providerSysId,
                order.providerOrderId
            );

        // ==================================
        // OTP RECEIVED
        // ==================================
        if (state && state.status === 'STATUS_OK') {

            order.status = 'COMPLETED';
            order.otp = state.code || 'N/A';

            orders[orderIndex] = order;

            saveDb(
                'orders.json',
                orders
            );
await providerService
                .setStatus(
                    order.providerSysId,
                    order.providerOrderId,
                    '5'
                )
                .catch(() => {});

            logger.info(
                'OTP_RECEIVED',
                `OTP received for ${orderId}`,
                order.userId
            );

            return await safeEdit(
                ctx,
                `🎉 <b>OTP RECEIVED</b>
─────────────────────────

📦 Service:
<b>${order.productName}</b>

📞 Number:
<code>${order.number}</code>

💬 OTP:
<code>${order.otp}</code>

✅ Verification completed.`,
                {
                    parse_mode: 'HTML'
                }
            );
        }

        // ==================================
        // CHECK TIMEOUT
        // ==================================
        const elapsed =
            Math.floor(
                (
                    Date.now() -
                    order.timestamp
                ) / 1000
            );

        if (
            elapsed >=
            settings.order_timeout
        ) {
            logger.info(
                'TIMEOUT',
                `Order ${orderId} expired`,
                order.userId
            );

            return await forceRollbackRefund(
                orderId,
                ctx
            );
        }

        return await ctx.answerCbQuery(
            `⏳ Waiting for OTP...\n${settings.order_timeout - elapsed}s remaining`
        );

    } catch (err) {
        logger.error(
            'ERROR',
            `handleCheckOTP failed: ${err.message}`,
            ctx.from?.id
        );

        return ctx.answerCbQuery(
            '⚠️ Provider unavailable.'
        );
    }
}

// ==========================================
// ❌ MODULE: CANCEL + REFUND
// ==========================================
async function forceRollbackRefund(
    orderId,
    ctx = null
) {
    try {
        const orders =
            loadDb('orders.json');

        const orderIndex =
            orders.findIndex(
                o => o.id === orderId
            );

        if (orderIndex === -1) {
            return;
        }

        const settings =
            getSettings();

        const order =
            orders[orderIndex];

        if (
            order.status !== 'WAITING'
        ) {
            if (
                ctx &&
                ctx.callbackQuery
            ) {
                return ctx.answerCbQuery(
                    '❌ Order already finalized.'
                );
            }

            return;
        }

        // ==============================
        // CANCEL AT PROVIDER
        // ==============================
let remain = 0;
console.log("DEBUG activationCancel =", order.activationCancel);
console.log("DEBUG timestamp =", order.timestamp);

const age = Math.floor(
    (Date.now() - order.timestamp) / 1000
);

remain = Math.max(0, 300 - age);

  const cancelResult =
    await providerService
        .setStatus(
            order.providerSysId,
            order.providerOrderId,
            '8'
        )
        .catch(() => 'ERROR');

if (cancelResult === 'EARLY_CANCEL_DENIED') {

    return ctx.answerCbQuery(
        '⏳ Provider has not allowed cancellation yet.',
        {
            show_alert: true
        }
    );
}

if (
    !cancelResult ||
    cancelResult === 'ERROR'
) {

    return ctx.answerCbQuery(
        '❌ Provider cancellation failed.',
        {
            show_alert: true
        }
    );
}

order.status = 'CANCELLED';
        orders[orderIndex] =
            order;

        saveDb(
            'orders.json',
            orders
        );

        // ==============================
        // REFUND USER
        // ==============================
        const wallets =
            loadDb('wallet.json');

        const wallet =
            wallets[order.userId];

        if (wallet) {

            wallet.balance +=
                Number(order.price);

            wallet.history.push({
                type: 'REFUND',
                amount:
                    Number(order.price),
                timestamp:
                    new Date().toISOString(),
                description:
                    `Refund for order ${order.id}`
            });

            wallets[order.userId] =
                wallet;

            saveDb(
                'wallet.json',
                wallets
            );
        }

        logger.info(
            'ORDER_CANCELLED',
            `Order ${orderId} cancelled`,
            order.userId
        );

        const currency = settings.currency === '$' ? '₹' : (settings.currency || '₹');

        const refundText =
`❌ <b>ORDER CANCELLED</b>
─────────────────────────

📞 Number:
<code>${order.number}</code>

💰 Refunded:
<b>${currency}${Number(order.price).toFixed(2)}</b>

✅ Balance restored.`;

        if (
            ctx &&
            ctx.callbackQuery
        ) {
            return await safeEdit(
                ctx,
                refundText,
                {
                    parse_mode: 'HTML'
                }
            );
        }

        if (order.chatId && order.messageId) {
            await telegram.editMessageText(
                order.chatId,
                Number(order.messageId),
                null,
                refundText,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        } else if (
            ctx &&
            ctx.telegram
        ) {
            await ctx.telegram
                .sendMessage(
                    order.userId,
                    refundText,
                    {
                        parse_mode: 'HTML'
                    }
                )
                .catch(() => {});
        }

    } catch (err) {
        logger.error(
            'ERROR',
            `forceRollbackRefund crashed: ${err.message}`
        );
    }
}

// ==========================================
// 🔄 ACTIVE ORDERS REFRESHER (setInterval 5s)
// ==========================================
async function refreshWaitingOrders() {
    let orders = [];
    try {
        orders = loadDb('orders.json');
    } catch (err) {
        return;
    }

    if (!Array.isArray(orders) || !orders.length) return;

    let settings = { currency: '₹', order_timeout: 600 };
    try {
        settings = getSettings();
    } catch {}

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        if (order.status !== 'WAITING') continue;
        if (!order.chatId || !order.messageId) continue;

        try {
            const elapsed = Math.floor((Date.now() - order.timestamp) / 1000);
            const timeoutSeconds = Number(settings.order_timeout || 600);

            // 1. Timeout processing
            if (elapsed >= timeoutSeconds) {
                await forceRollbackRefund(order.id, null);
                // Reload list to align updated indexes
                orders = loadDb('orders.json');
                i--;
                continue;
            }

            // 2. Poll OTP status automatically
            const state = await providerService.checkStatus(
                order.providerSysId,
                order.providerOrderId
            ).catch(() => null);

            if (state && state.status === 'STATUS_OK') {
                order.status = 'COMPLETED';
                order.otp = state.code || 'N/A';
                orders[i] = order;
                saveDb('orders.json', orders);

                await providerService
                    .setStatus(
                        order.providerSysId,
                        order.providerOrderId,
                        '5'
                    )
                    .catch(() => {});

                logger.info(
                    'OTP_RECEIVED',
                    `OTP received for ${order.id} in background`,
                    order.userId
                );

                const successText = `🎉 <b>OTP RECEIVED</b>
─────────────────────────

📦 Service:
<b>${order.productName}</b>

🌍 Country:
<b>${order.productCountry || 'Unknown'}</b>

📞 Number:
<code>${order.number}</code>

💬 OTP:
<code>${order.otp}</code>

✅ Verification completed.`;

                try {
                    await telegram.editMessageText(
                        order.chatId,
                        Number(order.messageId),
                        null,
                        successText,
                        { parse_mode: 'HTML' }
                    );
                } catch (editErr) {
                    if (!editErr.message || !editErr.message.includes('message is not modified')) {
                        logger.error('TELEGRAM_ERROR', `Failed to edit background success message: ${editErr.message}`);
                    }
                }
                continue;
            }

            // 3. Dynamic layout/countdown update
            const updatedText = getFormattedOrderText(order, settings);
            const buttons = [
                [
                    {
                        text: '🔄 Check OTP',
                        callback_data: `order_check_${order.id}`
                    }
                ]
            ];

if (elapsed < 300) {
    buttons.push([
        {
            text: `🔒 Cancel Locked (${300 - elapsed}s)`,
            callback_data: `order_cancel_${order.id}`
        }
    ]);
} else {
                buttons.push([
                    {
                        text: '❌ Cancel Order',
                        callback_data: `order_cancel_${order.id}`
                    }
                ]);
            }

            try {
                await telegram.editMessageText(
                    order.chatId,
                    Number(order.messageId),
                    null,
                    updatedText,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: buttons
                        }
                    }
                );
            } catch (editErr) {
                if (!editErr.message || !editErr.message.includes('message is not modified')) {
                    logger.error('TELEGRAM_ERROR', `Failed to update background countdown: ${editErr.message}`);
                }
            }

        } catch (orderErr) {
            logger.error('REFRESH_ORDER_ERROR', `Failed processing waiting order ${order.id}: ${orderErr.message}`);
        }
    }
}

// Background poller initializer
setInterval(async () => {
    try {
        await refreshWaitingOrders();
    } catch (err) {
        logger.error('INTERVAL_ERROR', `Error refreshing orders: ${err.message}`);
    }
}, 5000);

// ==========================================
// EXPORTS
// ==========================================
module.exports = {
    safeEdit,

    renderBuyMenu,

    renderPopularMenu,
    renderCategoryMenu,
    renderCategoryProducts,
    renderProductDetails,
    renderSearchMenu,
    renderSearchResults,
    handleSearchInput,

    renderRecentMenu,
    renderFavoritesMenu,

    handleBuyProduct,
    showLoading,
    handleCheckOTP,

    forceRollbackRefund
};

