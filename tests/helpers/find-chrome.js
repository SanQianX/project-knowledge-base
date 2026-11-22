const fs = require('fs');
const path = require('path');

function buildCandidates() {
  return [
    ['env', process.env.KB_CHROME_PATH],
    ['chrome-localappdata', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome-programfiles', process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome-programfiles-x86', process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['edge-programfiles', process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['edge-programfiles-x86', process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['linux-google-chrome', '/usr/bin/google-chrome'],
    ['linux-google-chrome-stable', '/usr/bin/google-chrome-stable'],
    ['linux-chromium', '/usr/bin/chromium'],
    ['linux-chromium-browser', '/usr/bin/chromium-browser'],
    ['macos-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ].filter(entry => entry[1]);
}

function findChromeDetailed() {
  const candidates = buildCandidates();
  for (const [source, candidate] of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, source };
  }
  const error = new Error(`Chrome/Chromium not found; checked: ${candidates.map(entry => entry[1]).join(', ')}`);
  error.code = 'KB_CHROME_NOT_FOUND';
  throw error;
}

function findChrome() {
  return findChromeDetailed().path;
}

module.exports = { findChrome, findChromeDetailed };
