const rateLimitMap = new Map();

function isRateLimited(userId) {
    const now = Date.now();
    const lastRequest = rateLimitMap.get(userId.toString()) || 0;
    if (now - lastRequest < 800) {
        return true;
    }
    rateLimitMap.set(userId.toString(), now);
    return false;
}

/**
 * Computes a risk analysis score for anti-fraud mitigation.
 */
function calculateRiskScore(refereeUser, referrerUser, metadata = {}) {
    let score = 0;
    const reasons = [];

    if (refereeUser.id.toString() === referrerUser.id.toString()) {
        score += 100;
        reasons.push('Self-referral attempt');
    }

    if (refereeUser.first_name === referrerUser.first_name) {
        score += 40;
        reasons.push('Identical display names');
    }

    if (refereeUser.username && referrerUser.username && refereeUser.username === referrerUser.username) {
        score += 50;
        reasons.push('Matching username attributes');
    }

    // Dynamic metadata checks (VPN, Fingerprints, Device IDs)
    if (metadata.is_vpn) {
        score += 30;
        reasons.push('VPN node flagged');
    }
    if (metadata.is_emulator) {
        score += 30;
        reasons.push('Emulator runtime environment flagged');
    }
    if (metadata.duplicate_fingerprint) {
        score += 50;
        reasons.push('Dynamic browser fingerprint collision');
    }

    return { score: Math.min(100, score), reasons };
}

module.exports = {
    isRateLimited,
    calculateRiskScore
};
