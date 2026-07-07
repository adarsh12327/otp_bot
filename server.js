const express = require('express');
const apiService = require('./services/apiService');
const logger = require('./utils/logger');

function initServer(port) {
    const app = express();
    app.use(express.json());

    // Simulated SMS Gateway API Endpoints
    app.use('/api', apiService);

    // Dynamic Platform Server Diagnostic Output
    app.get('/status', (req, res) => {
        res.json({
            platform: 'Enterprise SMS Platform',
            server_time: new Date().toISOString(),
            status: 'online'
        });
    });

    const server = app.listen(port, () => {
        console.log(`🌐 Platform server listening on port ${port}`);
        logger.info('SERVER_BOOT', `Server listening on port ${port}`);
    });

    return server;
}

module.exports = {
    initServer
};
