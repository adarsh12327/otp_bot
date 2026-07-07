const express = require('express');
const axios = require('axios');
const { loadDb } = require('../utils/database');
const logger = require('../utils/logger');

const router = express.Router();

// Optimized HTTP connection-reuse instance
const axiosInstance = axios.create({
    timeout: 5000,
    headers: { 'Connection': 'keep-alive' }
});

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ==========================================
// INTERNAL MOCK API STATE (SIMULATION ENDPOINTS)
// ==========================================
const internalOrders = {};

router.get('/getBalance', (req, res) => {
    res.json({ balance: 84520.00, currency: 'INR', status: 'healthy' });
});

router.get('/getNumber', (req, res) => {
    const { service } = req.query;
    const orderId = 'mock_api_' + Math.random().toString(36).substring(2, 9);
    const generatedNumber = '+91' + Math.floor(6000000000 + Math.random() * 4000000000).toString();

    internalOrders[orderId] = {
        id: orderId,
        service: service || 'tg',
        number: generatedNumber,
        status: 'WAITING',
        createdAt: Date.now(),
        otp: Math.floor(100000 + Math.random() * 900000).toString()
    };

    res.json({ id: orderId, number: generatedNumber });
});

router.get('/getStatus', (req, res) => {
    const { id } = req.query;
    const order = internalOrders[id];

    if (!order) {
        return res.status(404).json({ error: 'Mock order state not found' });
    }

    if (order.status === 'CANCELLED') {
        return res.json({ status: 'STATUS_CANCELLED' });
    }

    const elapsed = (Date.now() - order.createdAt) / 1000;
    if (elapsed > 10 && order.status === 'WAITING') {
        order.status = 'RECEIVED';
    }

    if (order.status === 'RECEIVED') {
        return res.json({ status: 'STATUS_OK', code: order.otp });
    }

    return res.json({ status: 'STATUS_WAIT_CODE' });
});

router.get('/setStatus', (req, res) => {
    const { id, status } = req.query;
    const order = internalOrders[id];

    if (!order) {
        return res.status(404).json({ error: 'Mock order state not found' });
    }

    if (status === '8') {
        order.status = 'CANCELLED';
        return res.json({ status: 'ACCESS_CANCEL' });
    } else if (status === '5') {
        order.status = 'COMPLETED';
        return res.json({ status: 'ACCESS_ACTIVATION' });
    }

    res.json({ status: 'UNKNOWN' });
});

// ==========================================
// ENTERPRISE OUTBOUND CLIENT CORE LOGIC
// ==========================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Strips keys, tokens, or API secrets from URLs before routing to audit logs.
 */
function sanitizeUrl(url) {
    if (!url) return '';
    return url.replace(/([\?&]key=)[^&]+/ig, '$1[REDACTED]')
              .replace(/([\?&]api_key=)[^&]+/ig, '$1[REDACTED]')
              .replace(/([\?&]token=)[^&]+/ig, '$1[REDACTED]');
}

/**
 * Validates request URLs to prevent SSRF and malformed network requests.
 */
function isValidUrl(urlString) {
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * Retrieves active providers from the database, sorted by priorities.
 */
function getActiveProviders() {
    try {
        const settings = loadDb('settings.json');
        const providers = loadDb('providers.json');
        const list = Array.isArray(providers) ? providers : (settings.providers || []);
        return list.filter(p => p.status === 'active').sort((a, b) => a.priority - b.priority);
    } catch (err) {
        logger.error('API_ERROR', 'Failed to read provider dataset profiles from database.');
        return [];
    }
}

/**
 * Standardizes raw number allocation responses from vendors.
 */
function normalizeNumberResponse(data) {
    if (!data) throw new Error('EMPTY_PROVIDER_RESPONSE');

    if (typeof data === 'object') {
        if (data.number && data.id) {
            return { id: data.id, number: data.number };
        }
        if (data.error || data.message) {
            throw new Error(data.error || data.message);
        }
    }

    const str = String(data).trim();
    if (str.startsWith('ACCESS_NUMBER:')) {
        const parts = str.split(':');
        if (parts.length >= 3) {
            return { id: parts[1], number: parts[2] };
        }
    }

    if (str === 'NO_NUMBERS') throw new Error('NO_NUMBERS');
    if (str === 'NO_BALANCE') throw new Error('NO_BALANCE');
    if (str === 'BAD_KEY') throw new Error('BAD_KEY');
    if (str === 'BAD_ACTION') throw new Error('BAD_ACTION');

    throw new Error(`UNEXPECTED_RESPONSE_FORMAT: ${str.substring(0, 50)}`);
}

/**
 * Standardizes raw balance retrieval responses from vendors.
 */
function normalizeBalanceResponse(data) {
    if (typeof data === 'object') {
        if (data.balance !== undefined) return parseFloat(data.balance);
        if (data.error) throw new Error(data.error);
    }

    const str = String(data).trim();
    if (str.startsWith('ACCESS_BALANCE:')) {
        const parts = str.split(':');
        return parseFloat(parts[1]);
    }

    const numeric = parseFloat(str);
    if (!isNaN(numeric)) return numeric;

    if (str === 'BAD_KEY') throw new Error('BAD_KEY');
    throw new Error(`UNEXPECTED_BALANCE_FORMAT: ${str.substring(0, 50)}`);
}

// ==========================================
// CLIENT MODULE EXPORTS
// ==========================================

async function getBalance(providerSysId = null) {
    try {
        const providers = getActiveProviders();
        const targets = providerSysId 
            ? providers.filter(p => p.id === providerSysId)
            : providers;

        if (targets.length === 0) {
            throw new Error(providerSysId ? 'SPECIFIED_PROVIDER_INACTIVE' : 'NO_ACTIVE_PROVIDERS');
        }

        // Try highest priority matching target
        const targetProv = targets[0];
        if (!isValidUrl(targetProv.url)) throw new Error('INVALID_API_URL');

        const sanitized = sanitizeUrl(`${targetProv.url}/getBalance`);
        logger.info('API_REQUEST', `Querying balance on ${targetProv.name} - Endpoint: ${sanitized}`);

        const response = await axiosInstance.get(`${targetProv.url}/getBalance`, {
            params: { key: targetProv.key }
        });

        const balance = normalizeBalanceResponse(response.data);
        logger.info('API_SUCCESS', `Balance parsed successfully for ${targetProv.name}: ${balance}`);
        return { balance, raw: response.data };
    } catch (err) {
        logger.error('API_ERROR', `Failed to retrieve balance values: ${err.message}`);
        return { balance: 0.0, error: err.message };
    }
}

async function getNumber(serviceCode) {
    try {
        if (!serviceCode) throw new Error('MISSING_SERVICE_CODE');

        const providers = getActiveProviders();
        if (providers.length === 0) throw new Error('NO_ACTIVE_PROVIDERS');

        let lastError = null;

        for (const prov of providers) {
            if (!isValidUrl(prov.url)) {
                logger.warn('API_VALIDATION', `Skipped misconfigured API URL on provider: ${prov.name}`);
                continue;
            }

            // Retry logic per provider loop
            for (let retry = 0; retry <= MAX_RETRIES; retry++) {
                try {
                    const sanitized = sanitizeUrl(`${prov.url}/getNumber?service=${serviceCode}`);
                    logger.info('API_REQUEST', `Requesting line from ${prov.name} (Attempt ${retry + 1}) - URL: ${sanitized}`);

                    const response = await axiosInstance.get(`${prov.url}/getNumber`, {
                        params: { service: serviceCode, key: prov.key }
                    });

                    const normalized = normalizeNumberResponse(response.data);
                    logger.info('API_SUCCESS', `Line successfully allocated from ${prov.name}: ${normalized.number}`);

                    return {
                        id: normalized.id,
                        number: normalized.number,
                        providerSysId: prov.id
                    };
                } catch (err) {
                    lastError = err;
                    logger.warn('API_RETRY', `Failed allocation on ${prov.name} (Attempt ${retry + 1}): ${err.message}`);
                    if (retry < MAX_RETRIES) {
                        await sleep(RETRY_DELAY_MS);
                    }
                }
            }
            logger.warn('API_FAILOVER', `Rollover active: Provider [${prov.name}] failed limit threshold. Querying failover gateways.`);
        }

        throw new Error(lastError ? lastError.message : 'ALL_PROVIDERS_FAILED');
    } catch (err) {
        logger.error('API_ERROR', `Line provisioning failed: ${err.message}`);
        throw err; // Forward exception safely to caller
    }
}

async function getStatus(providerSysId, rawProviderOrderId) {
    try {
        if (!providerSysId || !rawProviderOrderId) throw new Error('MISSING_STATUS_PARAMETERS');

        const providers = loadDb('providers.json');
        const prov = providers.find(p => p.id === providerSysId);

        if (!prov || !isValidUrl(prov.url)) {
            throw new Error('PROVIDER_MISCONFIGURED_OR_INACTIVE');
        }

        const sanitized = sanitizeUrl(`${prov.url}/getStatus?id=${rawProviderOrderId}`);
        logger.info('API_REQUEST', `Checking order status on ${prov.name} - URL: ${sanitized}`);

        const response = await axiosInstance.get(`${prov.url}/getStatus`, {
            params: { id: rawProviderOrderId, key: prov.key }
        });

        const data = response.data;
        if (typeof data === 'object') {
            if (data.status) return data;
            if (data.error) throw new Error(data.error);
        }

        const str = String(data).trim();
        if (str === 'STATUS_WAIT_CODE') return { status: 'STATUS_WAIT_CODE' };
        if (str === 'STATUS_CANCEL') return { status: 'STATUS_CANCELLED' };
        if (str.startsWith('STATUS_OK:')) {
            const parts = str.split(':');
            return { status: 'STATUS_OK', code: parts[1] };
        }

        return { status: str };
    } catch (err) {
        logger.error('API_ERROR', `Status lookup failed: ${err.message}`);
        return { status: 'ERROR', error: err.message };
    }
}

async function setStatus(providerSysId, rawProviderOrderId, statusPayloadCode) {
    try {
        if (!providerSysId || !rawProviderOrderId || !statusPayloadCode) {
            throw new Error('MISSING_SET_STATUS_PARAMETERS');
        }

        const providers = loadDb('providers.json');
        const prov = providers.find(p => p.id === providerSysId);

        if (!prov || !isValidUrl(prov.url)) {
            throw new Error('PROVIDER_MISCONFIGURED_OR_INACTIVE');
        }

        const sanitized = sanitizeUrl(`${prov.url}/setStatus?id=${rawProviderOrderId}&status=${statusPayloadCode}`);
        logger.info('API_REQUEST', `Setting code ${statusPayloadCode} on ${prov.name} - URL: ${sanitized}`);

        const response = await axiosInstance.get(`${prov.url}/setStatus`, {
            params: { id: rawProviderOrderId, status: statusPayloadCode, key: prov.key }
        });

        return { success: true, raw: response.data };
    } catch (err) {
        logger.error('API_ERROR', `Status update failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}

async function cancelOrder(providerSysId, rawProviderOrderId) {
    return setStatus(providerSysId, rawProviderOrderId, '8');
}

async function finishOrder(providerSysId, rawProviderOrderId) {
    return setStatus(providerSysId, rawProviderOrderId, '5');
}

async function healthCheck(providerSysId) {
    try {
        const res = await getBalance(providerSysId);
        return res.error ? { healthy: false, error: res.error } : { healthy: true, balance: res.balance };
    } catch (err) {
        return { healthy: false, error: err.message };
    }
}

// Bind enterprise methods to Router instance to preserve multi-architecture compatibility
router.getBalance = getBalance;
router.getNumber = getNumber;
router.getStatus = getStatus;
router.setStatus = setStatus;
router.cancelOrder = cancelOrder;
router.finishOrder = finishOrder;
router.healthCheck = healthCheck;

module.exports = router;
