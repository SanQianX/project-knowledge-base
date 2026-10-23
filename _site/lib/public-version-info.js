'use strict';
/**
 * Minimal read-only core version snapshot behind GET /api/system/version.
 *
 * The UI brand tooltip (ui/version-info.js) shows "知识库 vX.Y.Z" from this
 * one payload: the version of the Project Knowledge package this server
 * process is running — never a business repo's git tag, a sibling checkout,
 * npm latest, or the desktop shell version. Nothing is guessed: if the
 * running package cannot be read, `version` is null and the UI says 未知.
 *
 * (R1 of this lane shipped a full module-aggregation endpoint here — sidebar
 * entry, per-module table, desktop IPC. The user simplified the requirement
 * to a hover-only brand tooltip, so everything but this core snapshot was
 * reverted; see docs/plans/VERSION-VISIBILITY-2026-10-23.md.)
 */

const fs = require('fs');
const path = require('path');

const ROOT_PACKAGE = path.resolve(__dirname, '..', '..', 'package.json');
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE, 'utf8')); } catch { pkg = null; }

function coreVersionSnapshot() {
  return {
    ok: true,
    schema: 'system-version/v1',
    checkedAt: new Date().toISOString(),
    core: {
      name: pkg && typeof pkg.name === 'string' ? pkg.name : null,
      version: pkg && typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null,
      source: 'running-process-package',
    },
  };
}

module.exports = { coreVersionSnapshot };
