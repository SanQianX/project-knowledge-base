'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { bridgeBinding } = require('./capture-hook-config');

function readNotify(configFile) {
  const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const lines = source.split(/\r?\n/);
  const table = lines.findIndex(line => /^\s*\[/.test(line));
  const indexes = lines.map((line, index) => /^\s*notify\s*=/.test(line) && (table < 0 || index < table) ? index : -1).filter(index => index >= 0);
  if (!indexes.length) return { source, lines, index: -1, args: null };
  const index = indexes[0];
  const value = lines[index].replace(/^\s*notify\s*=\s*/, '');
  let args = null;
  try { args = JSON.parse(value); } catch {
    // Old Bridge versions emitted unescaped Windows paths in this one-line array.
    if (/^\s*\[.*\]\s*$/.test(value)) {
      const matcher = /"((?:\\.|[^"\\])*)"/g;
      const parts = [];
      let last = 0;
      let match;
      while ((match = matcher.exec(value))) {
        if (!/^[\s,\[]*$/.test(value.slice(last, match.index))) break;
        parts.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
        last = matcher.lastIndex;
      }
      if (parts.length && /^[\s,\]]*$/.test(value.slice(last))) args = parts;
    }
  }
  const valid = indexes.length === 1 && Array.isArray(args) && args.length && args.every(item => typeof item === 'string');
  return { source, lines, index, args: valid ? args : null, invalid: !valid };
}

function nested(args, marker) {
  const index = args.indexOf(marker);
  if (index < 0 || args.indexOf(marker, index + 1) >= 0) return null;
  const value = args[index + 1];
  if (typeof value !== 'string' || value.length > 1024 * 1024) return null;
  const candidates = marker === '--previous-notify' ? [value, Buffer.from(value, 'base64').toString('utf8')] : [Buffer.from(value, 'base64').toString('utf8')];
  for (const text of candidates) {
    try {
      const child = JSON.parse(text);
      if (Array.isArray(child) && child.length && child.every(item => typeof item === 'string')) return { index, args: child };
    } catch {}
  }
  return null;
}

function sameCommand(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function nodeCommand(args) { return /(?:^|[\\/])node(?:\.exe)?$/i.test(args[0] || ''); }
function normalized(file) { return String(file || '').replace(/\\/g, '/'); }
function fanoutPath(rootDir) { return path.join(rootDir, '_site', 'scripts', 'codex-notify-fanout.cjs'); }
function bridgeCommand(bridgeHomeDir) { return ['node', path.join(bridgeHomeDir, 'bin', 'bridge-hook.cjs')]; }
function ownedFanout(args, rootDir) {
  return nodeCommand(args) && (args[1] === fanoutPath(rootDir) || /\/node_modules\/(?:@sanqianx\/)?project-knowledge\/_site\/scripts\/codex-notify-fanout\.cjs$/i.test(normalized(args[1])));
}
function radarCommand(args) {
  return nodeCommand(args) && /\/(?:devtask-radar|DevTask Radar)\/connectors\/codex\/notify-hook\.js$/i.test(normalized(args[1]));
}
function desktopCommand(args) {
  return /\/OpenAI\/Codex\/runtimes\/cua_node\/[^/]+\/bin\/node_modules\/@oai\/sky\/bin\/windows\/codex-computer-use\.exe$/i.test(normalized(args[0])) && args[1] === 'turn-ended';
}
function retiredDesktop(args) {
  return desktopCommand(args) && !fs.existsSync(args[0]) && (args.length === 2 || (args.length === 4 && args[2] === '--previous-notify'));
}
function encode(args) { return Buffer.from(JSON.stringify(args)).toString('base64'); }
function fanout(next, options) {
  return ['node', fanoutPath(options.rootDir), ...(next ? ['--next-base64', encode(next)] : []), '--bridge-base64', encode(bridgeCommand(options.bridgeHomeDir))];
}

function inspectTree(args, options, state, depth = 0) {
  if (!args) return;
  if (depth > 16) throw Object.assign(new Error('通知链过深，请检查重复接入配置。'), { code: 'CAPTURE_CONFLICT' });
  if (ownedFanout(args, options.rootDir)) {
    const bridge = nested(args, '--bridge-base64');
    const next = nested(args, '--next-base64');
    if (!bridge || bridge.args.length !== 2 || !nodeCommand(bridge.args) || !/[\\/]bin[\\/]bridge-hook\.cjs$/i.test(bridge.args[1] || '') || (args.includes('--next-base64') && !next)
      || args.length !== (next ? 6 : 4)) throw Object.assign(new Error('托管通知链格式异常，未覆盖现有配置。'), { code: 'CAPTURE_CONFLICT' });
    state.owned = true;
    inspectTree(next && next.args, options, state, depth + 1);
  } else if (bridgeBinding(args, options)) {
    state.owned = true;
  } else if (desktopCommand(args)) {
    const previous = nested(args, '--previous-notify');
    if (args.includes('--previous-notify') && !previous) throw Object.assign(new Error('Codex 通知链格式异常，未覆盖现有配置。'), { code: 'CAPTURE_CONFLICT' });
    state.compatible = true;
    inspectTree(previous && previous.args, options, state, depth + 1);
  } else if (radarCommand(args)) {
    state.compatible = true;
    for (const marker of ['--previous-notify', '--next-base64']) {
      const child = nested(args, marker);
      if (args.includes(marker) && !child) throw Object.assign(new Error('已有通知链格式异常，未覆盖现有配置。'), { code: 'CAPTURE_CONFLICT' });
      inspectTree(child && child.args, options, state, depth + 1);
    }
  }
}

function replaceNested(args, marker, next) {
  const child = nested(args, marker);
  if (!child || sameCommand(child.args, next)) return args;
  const result = [...args];
  if (!next) result.splice(child.index, 2);
  else result[child.index + 1] = marker === '--previous-notify' ? JSON.stringify(next) : encode(next);
  return result;
}

function rewriteTree(args, options, state, canAnchor = true) {
  if (!args) return null;
  if (ownedFanout(args, options.rootDir)) {
    const next = nested(args, '--next-base64');
    const anchor = state.install && canAnchor && !state.attached;
    if (anchor) state.attached = true;
    const cleaned = rewriteTree(next && next.args, options, state, false);
    return anchor ? fanout(cleaned, options) : cleaned;
  }
  if (bridgeBinding(args, options)) return null;
  if (desktopCommand(args)) {
    const previous = nested(args, '--previous-notify');
    const cleaned = rewriteTree(previous && previous.args, options, state, canAnchor);
    // Only expired Codex-owned binaries may be collapsed. Missing user scripts
    // are not ours to delete, and live desktop wrappers keep their position.
    if (retiredDesktop(args)) return cleaned;
    return previous ? replaceNested(args, '--previous-notify', cleaned) : args;
  }
  if (radarCommand(args)) {
    let result = args;
    for (const marker of ['--previous-notify', '--next-base64']) {
      const child = nested(result, marker);
      if (child) result = replaceNested(result, marker, rewriteTree(child.args, options, state, false));
    }
    return result;
  }
  return args;
}

function attachCapture(args, options) {
  if (args && desktopCommand(args)) {
    const previous = nested(args, '--previous-notify');
    if (previous) return replaceNested(args, '--previous-notify', fanout(previous.args, options));
    return [...args, '--previous-notify', JSON.stringify(fanout(null, options))];
  }
  return fanout(args, options);
}

function planNotify(configFile, options, install = true) {
  const record = readNotify(configFile);
  const conflict = reason => ({ ...record, conflict: true, detail: reason });
  if (record.invalid) return conflict('通知配置不是可安全修改的根级单行数组，未覆盖。');
  const state = { owned: false, compatible: false, install, attached: false };
  try { inspectTree(record.args, options, state); } catch (error) { return conflict(error.message); }
  if (install && record.args && !state.owned && !state.compatible) return conflict('已有未知第三方通知配置，未覆盖；请保留原配置后人工确认接线。');
  if (!install && !state.owned) return { ...record, next: record.args, changed: false };
  let next = rewriteTree(record.args, options, state);
  if (install && !state.attached) next = attachCapture(next, options);
  return { ...record, next, changed: !sameCommand(record.args, next), conflict: false };
}

function writeNotify(configFile, plan) {
  if (!plan.changed) return { changed: false };
  if (plan.conflict) throw new Error('不能覆盖冲突的通知配置。');
  const current = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  if (current !== plan.source) throw Object.assign(new Error('通知配置已被其他程序修改，请重新接入。'), { code: 'CONFIG_CHANGED' });
  const eol = plan.source.includes('\r\n') ? '\r\n' : '\n';
  const lines = [...plan.lines];
  const entry = `notify = ${JSON.stringify(plan.next)}`;
  if (plan.index >= 0) {
    if (plan.next) lines[plan.index] = `${(lines[plan.index].match(/^\s*/) || [''])[0]}${entry}`;
    else lines.splice(plan.index, 1);
  } else {
    // notify is a root setting, never append it inside the last TOML table.
    lines.unshift(entry, '');
  }
  const source = lines.join(eol);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const backupFile = `${configFile}.project-knowledge-notify-${suffix}.bak`;
  // Back up only the setting we own; copying the entire config could duplicate
  // unrelated credentials. No command or encoded payload goes into logs.
  fs.writeFileSync(backupFile, JSON.stringify({ schema: 'project-knowledge/codex-notify-backup/v1', notify: plan.index < 0 ? null : plan.lines[plan.index] }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const temporary = `${configFile}.${suffix}.tmp`;
  try {
    fs.writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if ((fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '') !== plan.source) throw Object.assign(new Error('通知配置已被其他程序修改，请重新接入。'), { code: 'CONFIG_CHANGED' });
    fs.renameSync(temporary, configFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { changed: true, backupFile };
}

module.exports = { planNotify, writeNotify };
