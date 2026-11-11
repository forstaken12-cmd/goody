'use strict';

const { createApp } = require('./app');
const config = require('./config');

async function start() {
  const app = await createApp();
  const server = app.listen(config.port, () => {
    console.log(`Goody is running at http://localhost:${config.port}`);
    console.log(`Admin: http://localhost:${config.port}/admin`);
    if (config.demoPartner) console.log('Demo partner is ON (local fake offers and postbacks).');
  });
  const shutdown = () => {
    console.log('Stopping…');
    app.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, server };
}

if (require.main === module) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { start, createApp };
