// Shared git runner used by server.js, context-pack-builder.js, and tests.
// Wraps spawn() with a hard timeout and returns { ok, code, stdout, stderr, error }.

const { spawn } = require('child_process');
const fs = require('fs');

function execGit(cwd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: 'missing path', error: 'missing path' });
    }
    const child = spawn('git', args, { cwd, windowsHide: true, timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString('utf-8'));
    child.stderr.on('data', d => err += d.toString('utf-8'));
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', e => { clearTimeout(killer); resolve({ ok: false, code: -1, stdout: out, stderr: err, error: e.message }); });
    child.on('close', code => {
      clearTimeout(killer);
      resolve({ ok: code === 0 && !timedOut, code, stdout: out, stderr: err, error: timedOut ? 'timeout' : null });
    });
  });
}

module.exports = { execGit };
