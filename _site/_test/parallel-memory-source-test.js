'use strict';
// _site/_test/parallel-memory-source-test.js
//
// MEM-008 来源边界（维护 / 委派不自动成为人类偏好）.
//
// Real isolated product instance, real browser, real HTTP and real disk.
//
// Every case runs the REAL pipeline: a real follow-up commit, a real frozen
// conversation event with a real inputOrigin, the real promotion of a staged
// Markdown file and the engine's own MemoryService.capture() with its own
// provenance gate (MemoryEligibility). The stand-in analyzer plays the role of
// the model: it proposes a candidate that reads exactly like an owner
// preference, and the engine's own gate has to refuse it.
//
// HONEST SCOPE LABEL: the analysis step is this lane's declared stand-in
// analyzer. These cases prove the engine's admission gate, never the model's
// judgement about what is worth remembering.
//
// MEM-008 expected:
//   * 不自动成为人类偏好。 -> a delegated task order, an unverifiable source and
//                            a candidate without a user event are all refused
//                            by the engine's own gate; no memory is stored, the
//                            real candidate box stays empty and nothing is
//                            injected;
//   * C01未解决项明确阻断。  -> the human side cannot be proven in this batch:
//                            a real Workbench conversation is needed and MEM-007
//                            is deferred to the real-Workbench batch, so this
//                            case is reported as BLOCKED, not as a pass.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo, commitFile } = require('./helpers/parallel-memory-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const DELEGATED_TEXT = '委派指令：请在所有项目中统一使用中文错误提示。';
const UNKNOWN_TEXT = '来源不明的要求：所有提交信息必须使用祈使句。';
const UNSOURCED_TEXT = '维护产物自述：团队偏好所有注释使用中文。';
const MISSING_EVENT_TEXT = '引用不存在的事件：所有文档必须标注版本号。';

async function main() {
  const harness = await startHarness({ tag: 'memsource', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    const repo = makeRepo(harness.fixture, 'memsource-repo', { 'README.md': '# 来源甲\n' });
    const { projectId } = await harness.importProject(repo, '来源甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('来源甲')"),
      'the imported project is listed',
      20000,
    );

    /** Run one real maintenance round that proposes one candidate. */
    const attempt = async ({ file, content, document, candidate, inputOrigin = 'human', eventContent }) => {
      const head = commitFile(repo, file, content, 'source boundary commit');
      let event = null;
      if (eventContent !== null) {
        event = await harness.ingestUserEvent({ projectId, commitSha: head, content: eventContent, inputOrigin });
      }
      harness.plan.document = document;
      harness.plan.memoryCandidates = [candidate(event)];
      const run = await harness.triggerRun(projectId, head);
      return { run, commitSha: head, event, capture: run.memoryCapture };
    };

    // ------------------------------------------------------- delegated order
    const delegated = await attempt({
      file: 'src/delegated.js',
      content: `// ${DELEGATED_TEXT}\n`,
      document: `# 冻结证据\n\n${DELEGATED_TEXT}\n`,
      inputOrigin: 'agent-delegation',
      eventContent: `委派任务：${DELEGATED_TEXT}`,
      candidate: event => harness.memoryCandidate({ text: DELEGATED_TEXT, event, scopeType: 'global' }),
    });
    assert.equal(delegated.capture.accepted, 0, 'a delegated task order is not admitted');
    assert.deepEqual(delegated.capture.rejected.map(entry => entry.code), ['SOURCE_NOT_HUMAN'], 'the gate names the non-human source');

    // ------------------------------------------------------- unknown origin
    const unknown = await attempt({
      file: 'src/unknown.js',
      content: `// ${UNKNOWN_TEXT}\n`,
      document: `# 冻结证据\n\n${UNKNOWN_TEXT}\n`,
      inputOrigin: 'unknown',
      eventContent: `无法确认来源的输入：${UNKNOWN_TEXT}`,
      candidate: event => harness.memoryCandidate({ text: UNKNOWN_TEXT, event, scopeType: 'global' }),
    });
    assert.equal(unknown.capture.accepted, 0, 'an unverifiable source is not admitted');
    assert.deepEqual(unknown.capture.rejected.map(entry => entry.code), ['SOURCE_NOT_HUMAN'], 'the gate names the non-human source');

    // ------------------------------------- candidate without any user event
    const unsourced = await attempt({
      file: 'src/unsourced.js',
      content: `// ${UNSOURCED_TEXT}\n`,
      document: `# 冻结证据\n\n${UNSOURCED_TEXT}\n`,
      eventContent: `人工要求：${UNSOURCED_TEXT}`,
      candidate: () => ({
        text: UNSOURCED_TEXT,
        quote: UNSOURCED_TEXT,
        scopeType: 'global',
        eligibility: { durable: true, crossProject: true, reason: '人工明确表达的长期偏好', scopeReason: '适用于所有领域与项目' },
      }),
    });
    assert.equal(unsourced.capture.accepted, 0, 'a candidate without a user event is not admitted');
    assert.deepEqual(unsourced.capture.rejected.map(entry => entry.code), ['SOURCE_EVENT_MISSING'], 'the gate names the missing source event');

    // ------------------------------------------ candidate with a wrong event
    const missingEvent = await attempt({
      file: 'src/missing-event.js',
      content: `// ${MISSING_EVENT_TEXT}\n`,
      document: `# 冻结证据\n\n${MISSING_EVENT_TEXT}\n`,
      eventContent: `人工要求：${MISSING_EVENT_TEXT}`,
      candidate: () => ({
        text: MISSING_EVENT_TEXT,
        quote: MISSING_EVENT_TEXT,
        scopeType: 'global',
        sourceEventId: 'event-does-not-exist',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        eligibility: { durable: true, crossProject: true, reason: '人工明确表达的长期偏好', scopeReason: '适用于所有领域与项目' },
      }),
    });
    assert.equal(missingEvent.capture.accepted, 0, 'a candidate citing an unknown event is not admitted');
    assert.deepEqual(missingEvent.capture.rejected.map(entry => entry.code), ['SOURCE_EVENT_NOT_FOUND'], 'the gate names the unknown source event');

    // Nothing became a memory anywhere.
    const stored = await harness.productMemories();
    assert.deepEqual(stored, [], `no memory was stored: ${JSON.stringify(stored)}`);
    const injected = await harness.injectedMemories(projectId);
    assert.deepEqual(injected, [], `nothing is injected: ${JSON.stringify(injected)}`);

    // The real UI shows an empty candidate box and says the shell does not
    // turn project behaviour into the owner's preferences.
    await harness.reload();
    await harness.nativeClick('nav [data-view="memory"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-memory').classList.contains('active')"),
      'the memory view is open',
      10000,
    );
    await harness.nativeClick('[data-memory-tab="candidate"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('memoryContent').textContent.includes('候选箱为空。')"),
      'the candidate box is really empty once the engine answered again',
      20000,
    );
    const candidateBox = await harness.run("document.getElementById('memoryContent').textContent");
    assert.match(candidateBox, /候选箱为空。/, `the candidate box is really empty: ${candidateBox}`);
    assert.ok(!candidateBox.includes(DELEGATED_TEXT), 'the delegated order is not listed');
    assert.ok(!candidateBox.includes(UNSOURCED_TEXT), 'the unsourced preference is not listed');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem008-candidate-empty.png'));

    await harness.nativeClick('nav [data-view="home"]');
    await harness.waitFor(
      () => harness.run("document.getElementById('view-home').classList.contains('active')"),
      'the home view is open',
      10000,
    );
    const home = await harness.run("document.getElementById('homeContent').textContent");
    assert.match(home, /没有待确认记忆。智脑不会自动把项目行为当作你的偏好。/, `the home view states the boundary: ${home}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'mem008-home.png'));

    evidence.push({
      case: 'MEM-008',
      attempts: [
        { kind: 'agent-delegation', commitSha: delegated.commitSha, accepted: delegated.capture.accepted, rejected: delegated.capture.rejected },
        { kind: 'unknown', commitSha: unknown.commitSha, accepted: unknown.capture.accepted, rejected: unknown.capture.rejected },
        { kind: 'no-user-event', commitSha: unsourced.commitSha, accepted: unsourced.capture.accepted, rejected: unsourced.capture.rejected },
        { kind: 'unknown-event-id', commitSha: missingEvent.commitSha, accepted: missingEvent.capture.accepted, rejected: missingEvent.capture.rejected },
      ],
      storedMemories: stored,
      injected,
      ui: { candidateBox, home },
      blocked: [{
        id: 'C01',
        expectation: 'C01未解决项明确阻断。',
        status: 'BLOCKED',
        reason: 'The human side of the boundary needs a real Workbench conversation: whether a Workbench user event is the owner speaking depends on the unresolved C01 boundary-record chain. This batch has no real Workbench session (MEM-007 is deferred to the real-Workbench batch), so only the engine-side refusal of delegated / unverifiable / unsourced candidates is proven here.',
        evidenceInThisBatch: 'The engine conversation store was fed a real event with inputOrigin=human through the engine\'s own store, so the human path of the gate is exercised at the store level only.',
      }],
      scopeLabel: 'honest: the analysis step is the lane stand-in analyzer, not a model',
    });

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'mem008-source-boundary.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-source-test PASS (MEM-008 delegated / unverifiable / unsourced candidates are all refused by the real gate; C01 human-source determination is BLOCKED in this batch)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
