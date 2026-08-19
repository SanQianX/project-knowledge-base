// Deterministic fake browser: writes its pid to KB_FAKE_BROWSER_PIDFILE,
// prints a marker to stderr, then exits immediately without exposing CDP.
const fs = require('fs');

const pidFile = process.env.KB_FAKE_BROWSER_PIDFILE;
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
}
process.stderr.write('fake-browser-exit stderr: simulated browser crash before CDP\n');
process.exit(3);
