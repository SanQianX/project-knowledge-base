'use strict';
process.once('message', input => {
  const mode = input.managerOptions.homeDir;
  if (mode === 'crash') return process.exit(1);
  if (mode === 'hang') return setInterval(() => {}, 1000);
  setTimeout(() => {
    process.send({ ok: true, results: {
      claude: { state: 'failed', error: 'native repair failed' },
      codex: { state: 'repaired', error: null },
      zcode: { state: 'failed', error: 'unrequested result' },
    } }, () => process.disconnect());
  }, 80);
});
