// _site/_test/t07b-cln-005-coverage-test.js
//
// T07B ledger coverage for spec CLN-005 "活跃数据保留"
// (qa-autopilot/config/test-cases.json).
//
//   steps    : "ACTIVE/FAILED/RETAIN与旧PASSED目录混合。"
//   expected : "仅PASSED且到期进入清单；首失败/检查点/基线永不自动删。"
//
// The behaviour under test is the real cleanup planner of the QA control
// package (qa-autopilot/lib/safety.cjs -> cleanupPlan / applyCleanup) together
// with the real checkpoint store (qa-autopilot/lib/state.cjs -> Store). The
// fixture is an isolated QA root that mixes every run status, so the plan is
// checked against the spec itself and not against a hand-written expectation.
//
// Every assertion message starts with "QA-SPEC-CLN-005" so the controller can
// confirm on its own that this expectation is guarded.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTROL_ROOT = path.resolve(__dirname, '..', '..', 'qa-autopilot');
const SAFETY_LIB = path.join(CONTROL_ROOT, 'lib', 'safety.cjs');
const STATE_LIB = path.join(CONTROL_ROOT, 'lib', 'state.cjs');

if (!fs.existsSync(SAFETY_LIB) || !fs.existsSync(STATE_LIB)) {
  console.error('t07b-cln-005-coverage-test FAILED: QA control library is missing at ' + CONTROL_ROOT);
  process.exit(1);
}

const { cleanupPlan, applyCleanup, ownedRun, setRunStatus, readJSON, atomicJSON, hash } = require(SAFETY_LIB);
const { Store } = require(STATE_LIB);

const EPOCH = new Date(0).toISOString();
const RETENTION_HOURS = 1;
const FIRST_FAILURE_LOG = 'first failure stdout (redacted)\n';
const FIRST_FAILURE_SHOT = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Creates a real owned run directory through the control library, then pins the
// finished timestamp so "expired" and "not expired" are decided by the fixture
// and not by wall-clock luck.
function ownedRunWithStatus(qa, id, status, finishedAt) {
  const dir = ownedRun(qa, id);
  setRunStatus(dir, status);
  const marker = path.join(dir, '.qa-owner.json');
  const state = readJSON(marker);
  state.finishedAt = finishedAt;
  atomicJSON(marker, state);
  return dir;
}

function readBytes(file) {
  return fs.readFileSync(file);
}

const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cln005-'));
try {
  const runsRoot = path.join(qa, '.runtime', 'runs');

  // --- mixed run fixture: only one of these may ever reach the cleanup list ---
  const expired = ownedRunWithStatus(qa, 'expired-passed', 'PASSED', EPOCH);
  writeFile(path.join(expired, 'temp.txt'), 'expired run payload');
  writeFile(path.join(expired, 'logs', 'stdout.log'), 'expired run log');

  const fresh = ownedRunWithStatus(qa, 'fresh-passed', 'PASSED', new Date().toISOString());
  writeFile(path.join(fresh, 'temp.txt'), 'fresh run payload');

  // An ACTIVE run is protected by its status alone, even when it looks ancient.
  const active = ownedRunWithStatus(qa, 'active-run', 'ACTIVE', EPOCH);
  writeFile(path.join(active, 'temp.txt'), 'active run payload');

  const failed = ownedRunWithStatus(qa, 'failed-run', 'FAILED', EPOCH);
  writeFile(path.join(failed, 'first-failure', 'stdout.log'), FIRST_FAILURE_LOG);
  writeFile(path.join(failed, 'first-failure', 'screenshot.png'), FIRST_FAILURE_SHOT);

  const retained = ownedRunWithStatus(qa, 'retained-run', 'RETAIN', EPOCH);
  writeFile(path.join(retained, 'evidence.json'), '{"retained":true}');

  // A PASSED run without a usable finishedAt has no proven expiry.
  const brokenFinished = ownedRunWithStatus(qa, 'broken-finished-run', 'PASSED', 'not-a-date');
  writeFile(path.join(brokenFinished, 'temp.txt'), 'broken finished payload');

  // Runs this controller does not own: no marker, a foreign id, a foreign root.
  const unowned = path.join(runsRoot, 'unowned-run');
  writeFile(path.join(unowned, 'data.txt'), 'unowned payload');

  const foreignId = path.join(runsRoot, 'foreign-id-run');
  writeFile(path.join(foreignId, 'data.txt'), 'foreign id payload');
  atomicJSON(path.join(foreignId, '.qa-owner.json'), {
    schema: 1, id: 'another-id', root: fs.realpathSync(runsRoot), createdAt: EPOCH, status: 'PASSED', finishedAt: EPOCH,
  });

  const foreignRoot = path.join(runsRoot, 'foreign-root-run');
  writeFile(path.join(foreignRoot, 'data.txt'), 'foreign root payload');
  atomicJSON(path.join(foreignRoot, '.qa-owner.json'), {
    schema: 1, id: 'foreign-root-run', root: path.join(qa, 'elsewhere'), createdAt: EPOCH, status: 'PASSED', finishedAt: EPOCH,
  });

  // --- checkpoint, baseline and work clone live outside the run area ---
  const store = new Store(path.join(qa, 'state'));
  const checkpoint = store.transition('BASELINE_VERIFYING');
  const checkpointFile = path.join(qa, 'state', 'checkpoint.json');
  const journalFile = path.join(qa, 'state', 'journal', '00000001.json');

  const baselineRecord = {
    baseSha: 'b'.repeat(40), tag: 'qa-baseline-20261020', branch: 'qa/test-20261020', status: 'REMOTE_BASELINE_CONFIRMED',
  };
  const baselineFile = path.join(qa, 'state', 'baseline.json');
  atomicJSON(baselineFile, baselineRecord);

  const workspaceFile = path.join(qa, '.runtime', 'workspaces', 'repair', 'src', 'app.js');
  writeFile(workspaceFile, 'console.log("work clone");\n');

  // --- dry run ---
  const plan = cleanupPlan(qa, RETENTION_HOURS);
  const planFile = path.join(qa, 'state', 'cleanup-plan.json');
  atomicJSON(planFile, { olderThanHours: RETENTION_HOURS, plan, planHash: hash(JSON.stringify(plan)) });

  // Only the expired, owned, PASSED run may enter the list.
  assert.deepEqual(
    plan.map(item => item.id),
    ['expired-passed'],
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：混合目录中只有已到期的自有PASSED运行进入清单',
  );
  assert.equal(plan[0].id, 'expired-passed', 'QA-SPEC-CLN-005 仅PASSED且到期进入清单：进入清单的运行必须是已到期的PASSED运行');

  const plannedFiles = plan.flatMap(item => item.entries.map(entry => entry.relative));
  assert.ok(
    plannedFiles.includes(path.join('expired-passed', 'temp.txt')),
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：清单逐文件列出到期运行的内容',
  );
  assert.ok(
    plannedFiles.includes(path.join('expired-passed', 'logs', 'stdout.log')),
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：清单逐文件列出到期运行的子目录内容',
  );
  assert.ok(
    plan[0].entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)),
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：每个被列入的文件都带可核对的哈希',
  );

  // Every other run status and every foreign directory stays out of the list.
  for (const id of ['fresh-passed', 'active-run', 'failed-run', 'retained-run', 'broken-finished-run', 'unowned-run', 'foreign-id-run', 'foreign-root-run']) {
    assert.ok(
      !plannedFiles.some(relative => relative.startsWith(id + path.sep)),
      'QA-SPEC-CLN-005 仅PASSED且到期进入清单：' + id + ' 不得进入清理清单',
    );
  }

  // The retention floor keeps a just finished run out of reach.
  assert.throws(
    () => cleanupPlan(qa, 0),
    { code: 'RETENTION' },
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：保留期低于一小时时拒绝出清单',
  );

  // --- apply the reviewed plan ---
  const deleted = applyCleanup(qa, { olderThanHours: RETENTION_HOURS, planHash: hash(JSON.stringify(plan)) });
  assert.deepEqual(
    deleted,
    ['expired-passed'],
    'QA-SPEC-CLN-005 仅PASSED且到期进入清单：执行时只删除清单里的到期PASSED运行',
  );
  assert.equal(fs.existsSync(expired), false, 'QA-SPEC-CLN-005 仅PASSED且到期进入清单：到期PASSED运行被真正删除');
  assert.equal(fs.existsSync(path.join(expired, 'temp.txt')), false, 'QA-SPEC-CLN-005 仅PASSED且到期进入清单：到期运行的文件被逐个删除');

  // Active / failed / retained / fresh runs and their payloads stay untouched.
  assert.equal(fs.existsSync(active), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：ACTIVE运行目录被保留');
  assert.equal(fs.readFileSync(path.join(active, 'temp.txt'), 'utf8'), 'active run payload', 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：ACTIVE运行内容被保留');

  assert.equal(fs.existsSync(failed), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：FAILED运行目录被保留');
  assert.equal(fs.readFileSync(path.join(failed, 'first-failure', 'stdout.log'), 'utf8'), FIRST_FAILURE_LOG, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：首失败日志被保留');
  assert.ok(readBytes(path.join(failed, 'first-failure', 'screenshot.png')).equals(FIRST_FAILURE_SHOT), 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：首失败截图被保留');

  assert.equal(fs.existsSync(retained), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：RETAIN运行目录被保留');
  assert.equal(fs.readFileSync(path.join(retained, 'evidence.json'), 'utf8'), '{"retained":true}', 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：RETAIN运行证据被保留');

  assert.equal(fs.existsSync(fresh), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：未到期的PASSED运行被保留');
  assert.equal(fs.readFileSync(path.join(fresh, 'temp.txt'), 'utf8'), 'fresh run payload', 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：未到期运行内容被保留');

  for (const id of ['unowned-run', 'foreign-id-run', 'foreign-root-run', 'broken-finished-run']) {
    assert.equal(fs.existsSync(path.join(runsRoot, id)), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：非自有运行目录 ' + id + ' 被保留');
  }
  assert.equal(fs.readFileSync(path.join(unowned, 'data.txt'), 'utf8'), 'unowned payload', 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：无归属标记的目录内容被保留');

  // Checkpoint, baseline and the work clone are outside the cleanup scope.
  assert.equal(fs.existsSync(checkpointFile), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：检查点文件被保留');
  assert.deepEqual(readJSON(checkpointFile), checkpoint, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：检查点内容未被改动');
  assert.equal(fs.existsSync(journalFile), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：检查点日志被保留');
  assert.equal(fs.existsSync(baselineFile), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：基线记录被保留');
  assert.deepEqual(readJSON(baselineFile), baselineRecord, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：基线记录内容未被改动');
  assert.equal(fs.existsSync(workspaceFile), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：工作clone不在清理范围');
  assert.equal(fs.existsSync(planFile), true, 'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：已审计的清理计划记录被保留');

  // A survivor never silently turns into a deletion candidate.
  assert.deepEqual(
    cleanupPlan(qa, RETENTION_HOURS),
    [],
    'QA-SPEC-CLN-005 首失败/检查点/基线永不自动删：清理后重新出清单仍为空，保留数据不会自动变成可删数据',
  );

  console.log('t07b-cln-005-coverage-test PASS (QA-SPEC-CLN-005: only expired owned PASSED runs are listed and deleted; first failure, checkpoint and baseline are never auto-deleted)');
} finally {
  fs.rmSync(qa, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
