const fs = require('fs');
const path = require('path');

function findChrome() {
  const candidates = [
    process.env.KB_CHROME_PATH,
    'C:\\Users\\SanQian\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error(`Chrome/Chromium not found; checked: ${candidates.join(', ')}`);
  return chrome;
}

module.exports = { findChrome };
