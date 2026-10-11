'use strict';

const http = require('node:http');
const { SIGNAL_PATH, parsePort, peerSettings, allowedOrigins } = require('./config.cjs');
const { attachRooms } = require('./rooms.cjs');

function createService({ express, ExpressPeerServer, roomSocket = attachRooms, env = process.env, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/', (_req, res) => res.status(200).json({ service: 'roomwave-signaling', status: 'ok' }));
  app.get('/health', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Health is public and contains no sensitive data.
    res.status(200).json({ status: 'ok' });
  });
  const server = http.createServer(app);
  const peerServer = ExpressPeerServer(server, peerSettings(env));
  app.use(SIGNAL_PATH, peerServer);
  const rooms = roomSocket(server, {allowedOrigins: allowedOrigins(env.ALLOWED_ORIGINS), logger});
  peerServer.on('error', (err) => logger.error('Signaling error:', err.message));
  return { server, app, peerServer, rooms };
}

function start(env = process.env) {
  const port = parsePort(env.PORT);
  const { server } = createService({
    express: require('express'), ExpressPeerServer: require('peer').ExpressPeerServer, env,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Roomwave signaling ready on port ${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();
module.exports = { createService, start };
