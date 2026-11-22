// Deterministic fake browser: writes its pid to KB_FAKE_BROWSER_PIDFILE,
// stays alive forever, and never exposes a CDP endpoint.
const fs = require('fs');

const pidFile = process.env.KB_FAKE_BROWSER_PIDFILE;
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
}
process.stderr.write('fake-browser-hang stderr: alive but CDP never starts\n');
setInterval(() => {}, 60000);
