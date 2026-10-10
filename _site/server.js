// Project Knowledge v2 HTTP entry point.
const { startServer, installProcessHandlers } = require('./lib/server-app');

const instancePromise = startServer();
installProcessHandlers(instancePromise);
module.exports = instancePromise;

instancePromise.then(instance => {
  process.stdout.write(`Project Knowledge listening on http://${instance.host}:${instance.port}\n`);
}).catch(error => {
  if (require.main === module) {
    process.stderr.write(`[project-knowledge] startup failed: ${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  }
});
