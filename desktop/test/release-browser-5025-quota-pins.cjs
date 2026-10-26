'use strict';
// desktop/test/release-browser-5025-quota-pins.cjs
//
// The PURE Workbench quota-17 pin selector shared by
// desktop/test/release-browser-5025-smoke.cjs and its focused test.
//
// Nothing here touches the filesystem, the network, a service or a browser:
// importing this module starts nothing.
//
// Three pin tables, each with the SAME 17 audited quota sources:
//   - FROZEN (localModules.WB_QUOTA_AUDITED): the frozen 0.13.7-era baseline
//     (shipped pins, notShipped, versionDoc). It is never changed here.
//   - 0.13.8: the R20 Leader-reviewed re-base — ONLY 3 of the 17 entries are
//     re-pinned (workbench-service.js, http-handler.js, client/index.js); the
//     other 14 keep the frozen baseline entries, including notShipped and
//     versionDoc.
//   - 0.13.9: the R42 reviewed table — the 0.13.8 table plus ONLY
//     packages/ui/ai-profile-settings.js (the R33/R33B quota patch, source
//     commit 928c1bb; the bytes are the official 0.13.9 artifact, proven
//     identical to the installed official package by the R36 review). The other
//     16 entries are unchanged, notShipped and versionDoc semantics included.
//
// The selection is EXACT-VERSION. An unknown version selects NOTHING, so the
// caller keeps the strict frozen baseline: never a skip, never a table derived
// from the candidate under test.

const localModules = require('./release-preflight-5025-local-modules.cjs');

const WB_VERSION_0138 = '0.13.8';
const WB_VERSION_0139 = '0.13.9';

// R20 Leader-reviewed 0.13.8 re-base: ONLY these 3 of the 17 audited quota
// sources changed in 0.13.8; the other 14 keep the frozen baseline entries.
const WB_QUOTA_AUDITED_0138 = Object.assign({}, localModules.WB_QUOTA_AUDITED, {
  'packages/server/lib/workbench-service.js': { sha256: 'e72686c654e0373c562fbbe3c858c46fc104e198d5f6e44f59153247292bfea9', source: 'r20-leader-0138' },
  'packages/server/lib/http-handler.js': { sha256: '143892a94e6a9d7a1e58a6dfba18f4e11f52d15465687a99addfcadf62b662f0', source: 'r20-leader-0138' },
  'packages/client/index.js': { sha256: '493938f0ff357aea6db136fca216c6cfcb542d51f6628e1994a179b5ec296a12', source: 'r20-leader-0138' },
});

// R42 reviewed 0.13.9 re-base: the 0.13.8 table plus ONLY the quota patch
// entry. All other 16 entries (including the four notShipped entries and the
// versionDoc openapi.yaml) are unchanged.
const WB_QUOTA_AUDITED_0139 = Object.assign({}, WB_QUOTA_AUDITED_0138, {
  'packages/ui/ai-profile-settings.js': { sha256: '3c7a75833a3c4f607739ecf71a0716e27c8594cecd9d84e2f8ac99498a59e0e7', source: 'r33-r33b-quota-928c1bb-official-r36' },
});

// The pin table for an exact Workbench version, or undefined for every other
// version (the caller then keeps the strict frozen baseline).
const WB_QUOTA_TABLES = {
  [WB_VERSION_0138]: WB_QUOTA_AUDITED_0138,
  [WB_VERSION_0139]: WB_QUOTA_AUDITED_0139,
};

// The truthful label of the table a version is audited against.
function describeWbQuotaTable(version) {
  if (version === WB_VERSION_0138) {
    return '0.13.8-reviewed (R20: ONLY 3 re-pinned leader-verified entries, 14 frozen)';
  }
  if (version === WB_VERSION_0139) {
    return '0.13.9-reviewed (R42: 0.13.8-reviewed + ONLY packages/ui/ai-profile-settings.js, the R33/R33B quota patch 928c1bb)';
  }
  return 'frozen-default';
}

function selectWbQuotaTable(version) {
  return Object.prototype.hasOwnProperty.call(WB_QUOTA_TABLES, version)
    ? WB_QUOTA_TABLES[version]
    : undefined;
}

module.exports = {
  WB_VERSION_0138,
  WB_VERSION_0139,
  WB_QUOTA_AUDITED_0138,
  WB_QUOTA_AUDITED_0139,
  WB_QUOTA_TABLES,
  selectWbQuotaTable,
  describeWbQuotaTable,
};
