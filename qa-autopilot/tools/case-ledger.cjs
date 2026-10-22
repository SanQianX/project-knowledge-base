#!/usr/bin/env node
'use strict';
/**
 * 130 项用例的逐条断言级台账。
 *
 * 判定纪律：
 *   - 一条用例只有在它的每一项期望都绑定到真实断言、并且这些断言在本轮真实执行且通过时，才记 ASSERTED_PASS。
 *   - 绑定到的断言执行失败 → ASSERTED_FAIL，并带失败用例名与来源文件。
 *   - 绑定存在但断言没执行（例如本轮没跑那个测试文件）→ NOT_RUN。
 *   - 缺少可记录的前提（OS 级沙箱、真实 CI、真实 registry、OIDC 身份…）→ BLOCKED，并写明缺什么。
 *   - 其余 → NOT_RUN，写明残差。
 *   - “测试文件提到某个源文件”“候选套件文件级通过”都不构成用例覆盖，只能作为 file-level 部分证据列出。
 */
const fs = require('node:fs');
const path = require('node:path');
const qaRoot = path.resolve(__dirname, '..');
const CASES = path.join(qaRoot, 'config', 'test-cases.json');
const BINDINGS = path.join(qaRoot, 'config', 'case-assertions.json');
const SUITES = path.join(qaRoot, 'config', 'suites.json');

function arg(name, fallback) { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

/** 静态扫描测试文件：把 QA-SPEC 标记绑到它所属的 test(...) 用例名上。 */
function scanTestBlocks(file) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = null;
    lines.forEach((line, i) => {
        const isTest = /^\s*test\(/.test(line);
        if (isTest) {
            current = { file, line: i + 1, nameLiteral: null, markers: [] };
            // REV-04：只有单/双引号字面量名可唯一对位；模板字面量、拼接或表达式名
            // 记 null——解析侧不得再用同文件其他用例的结果抵扣该绑定。
            const m = line.match(/test\(\s*'([^']*)'/) || line.match(/test\(\s*"([^"]*)"/);
            if (m) current.nameLiteral = m[1];
            blocks.push(current);
        }
        if (!current) return;
        for (const hit of line.matchAll(/QA-SPEC-([A-Z]{3}-\d{3})([^'"\\]*)/g))
            current.markers.push({ caseId: 'QA-SPEC-' + hit[1], message: hit[2].trim(), line: i + 1 });
    });
    return blocks;
}

/**
 * 解析 node:test 的 TAP 输出：测试名 → PASS/FAIL/SKIP/TODO。
 * REV-03：行尾 directive（# SKIP / # TODO）单独判定，SKIP/TODO 永不记 PASS；
 * 真实的 not ok 具有粘性——不被后续同名 ok 覆盖。
 */
function parseTap(file) {
    const results = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(not ok|ok) \d+ - (.*?)(?:\s*#\s*(SKIP|TODO)(?:\s+.*)?)?$/);
        if (!m) continue;
        const name = m[2].trim();
        let status;
        if (m[3]) status = m[3];
        else status = m[1] === 'ok' ? 'PASS' : 'FAIL';
        if (results.get(name) === 'FAIL') continue;
        results.set(name, status);
    }
    return results;
}

/**
 * REV-04 名字对位：只允许精确相等，或拼接前缀（nameLiteral 以空格结尾且 TAP 名
 * 以其开头）。nameLiteral 为 null/undefined（模板字面量、表达式名）时返回空——
 * 不得用同文件其他用例的结果抵扣该绑定。
 */
function matchTestNames(nameLiteral, tapNames) {
    if (nameLiteral === null || nameLiteral === undefined) return [];
    return [...tapNames].filter(n => n === nameLiteral || (nameLiteral.endsWith(' ') && n.startsWith(nameLiteral)));
}

/** REV-03 绑定判定：全 SKIP/TODO → 未执行；全 PASS → PASS；其余（含真实 FAIL、PASS/SKIP 混合）→ FAIL。 */
function bindingOutcome(statuses) {
    if (!statuses.length) return 'NOT_EXECUTED';
    if (statuses.every(s => s === 'SKIP' || s === 'TODO')) return 'NOT_EXECUTED';
    return statuses.every(s => s === 'PASS') ? 'PASS' : 'FAIL';
}

/** 收据：产品测试文件 → 最近一次真实运行结果（文件级证据）。 */
function collectReceipts(dir) {
    const byFile = new Map();
    if (!dir || !fs.existsSync(dir)) return byFile;
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        for (const e of fs.readdirSync(current, { withFileTypes: true })) {
            const p = path.join(current, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (e.name !== 'receipt.json') continue;
            let r; try { r = readJSON(p); } catch { continue; }
            if (r.kind !== 'suite') continue;
            for (const row of r.results || []) {
                const prev = byFile.get(row.file);
                if (!prev || String(r.at || '') > String(prev.at || ''))
                    byFile.set(row.file, { status: row.status, exitCode: row.exitCode, suite: r.suite, run: path.basename(path.dirname(p)), at: r.at });
            }
        }
    }
    return byFile;
}

function main() {
    const tapDir = path.resolve(arg('tap', path.join(qaRoot, '.runtime', 'tap')));
    const out = path.resolve(arg('out', path.join(qaRoot, 'artifacts', 'case-ledger.json')));
    const receiptsDir = path.resolve(arg('receipts', path.join(qaRoot, 'artifacts')));

    const cases = readJSON(CASES).cases;
    const table = readJSON(BINDINGS);
    const suites = readJSON(SUITES);

    const blocks = [];
    const testDir = path.join(qaRoot, 'tests');
    for (const name of fs.readdirSync(testDir).filter(f => f.endsWith('.test.cjs')).sort())
        blocks.push(...scanTestBlocks(path.join(testDir, name)));

    const tap = new Map();   // test file name -> {name -> ok|not ok}
    const tapFiles = [];
    if (fs.existsSync(tapDir)) {
        for (const name of fs.readdirSync(tapDir).filter(f => f.endsWith('.tap')).sort()) {
            const key = name.replace(/\.tap$/, '');
            tap.set(key, parseTap(path.join(tapDir, name)));
            tapFiles.push(path.join(tapDir, name));
        }
    }

    const receipts = collectReceipts(receiptsDir);

    /** 找到一条绑定对应的断言块与它的执行结果。 */
    function resolveBinding(binding) {
        const hits = [];
        for (const block of blocks) {
            if (!block.markers.some(m => m.caseId === binding.marker && m.message.includes(binding.message))) continue;
            const results = tap.get(path.basename(block.file)) || new Map();
            const names = matchTestNames(block.nameLiteral, results.keys());
            const outcome = bindingOutcome(names.map(n => results.get(n)));
            hits.push({
                file: path.relative(qaRoot, block.file).split(path.sep).join('/'),
                test: block.nameLiteral,
                marker: binding.marker,
                message: binding.message,
                executedTests: names,
                results: names.map(n => ({ test: n, result: results.get(n) })),
                outcome
            });
        }
        return hits;
    }

    const rows = [];
    for (const c of cases) {
        const spec = table.cases[c.id] || null;
        const row = {
            id: c.id, module: c.module, title: c.title, priority: c.priority, mode: c.mode,
            candidateSuite: c.candidateSuite, status: 'NOT_RUN', expectations: [], evidence: [],
            partialEvidence: [], blocked: null, residual: null, fileLevelEvidence: []
        };
        // 文件级部分证据：候选套件里真实跑过的文件（不是用例覆盖）。
        if (c.mode !== 'CONTROLLER_ACCEPTANCE') {
            const files = suites[c.candidateSuite] || [];
            row.fileLevelEvidence = files.filter(f => receipts.has(f)).map(f => ({ file: f, ...receipts.get(f) }));
        }
        if (!spec) {
            row.status = (table.productCaseDefault && table.productCaseDefault.status) || 'NOT_RUN';
            row.residual = (table.productCaseDefault && table.productCaseDefault.residual) || '没有绑定到任何真实断言。';
            row.evidenceLevel = 'file-level-only';
            rows.push(row);
            continue;
        }
        if (spec.blocked) {
            row.status = 'BLOCKED';
            row.blocked = spec.blocked;
            row.residual = spec.blocked.residual || null;
            rows.push(row);
            continue;
        }
        let anyFail = false, anyExecuted = false, allCovered = true;
        for (const exp of spec.expectations || []) {
            const hits = exp.bindings.flatMap(b => resolveBinding(b));
            const outcome = !hits.length ? 'NO_BINDING' : (hits.some(h => h.outcome === 'FAIL') ? 'FAIL' : (hits.some(h => h.outcome === 'NOT_EXECUTED') ? 'NOT_EXECUTED' : 'PASS'));
            if (outcome === 'FAIL') anyFail = true;
            if (outcome === 'PASS') anyExecuted = true;
            if (outcome !== 'PASS') allCovered = false;
            row.expectations.push({ key: exp.key, text: exp.text, outcome, assertions: hits });
            row.evidence.push(...hits.filter(h => h.outcome === 'PASS').map(h => ({ file: h.file, test: h.test, marker: h.marker, message: h.message })));
        }
        for (const pe of spec.partialEvidence || []) {
            const hits = (pe.bindings || []).flatMap(b => resolveBinding(b));
            row.partialEvidence.push({
                key: pe.key, note: pe.note,
                outcome: !hits.length ? 'NO_BINDING' : (hits.some(h => h.outcome === 'FAIL') ? 'FAIL' : (hits.some(h => h.outcome === 'NOT_EXECUTED') ? 'NOT_EXECUTED' : 'PASS')),
                assertions: hits
            });
        }
        if (spec.productBindings) {
            row.productEvidence = spec.productBindings.map(pb => {
                const receipt = receipts.get(pb.file);
                return {
                    file: pb.file, note: pb.note,
                    status: receipt ? receipt.status : 'NOT_EXECUTED',
                    run: receipt ? receipt.run : null,
                    suite: receipt ? receipt.suite : null
                };
            });
        }
        row.status = anyFail ? 'ASSERTED_FAIL' : (allCovered && (spec.expectations || []).length ? 'ASSERTED_PASS' : 'NOT_RUN');
        row.residual = spec.residual || (row.status === 'ASSERTED_PASS' ? null : '绑定到断言但本轮未全部执行或未全部通过。');
        row.evidenceLevel = 'assertion-level';
        rows.push(row);
    }

    const byStatus = {};
    const byMode = {};
    for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        byMode[r.mode] = byMode[r.mode] || { total: 0 };
        byMode[r.mode].total++;
        byMode[r.mode][r.status] = (byMode[r.mode][r.status] || 0) + 1;
    }
    const outDoc = {
        schema: 'qa-autopilot/case-ledger/v2',
        generatedAt: new Date().toISOString(),
        discipline: 'ASSERTED_PASS 需要每项期望都被真实执行且通过的断言覆盖；文件级套件通过只作为部分证据。',
        inputs: {
            tapFiles: tapFiles.map(p => path.relative(qaRoot, p).split(path.sep).join('/')),
            receiptsDir: path.relative(qaRoot, receiptsDir).split(path.sep).join('/'),
            boundCases: Object.keys(table.cases).length,
            scannedTestFiles: fs.readdirSync(testDir).filter(f => f.endsWith('.test.cjs')).length,
            markerBlocks: blocks.filter(b => b.markers.length).length
        },
        summary: { total: rows.length, byStatus, byMode },
        cases: rows
    };
    writeJSON(out, outDoc);
    console.log(JSON.stringify({ out: path.relative(qaRoot, out), summary: outDoc.summary }, null, 2));
}
if (require.main === module) main();
module.exports = { scanTestBlocks, parseTap, matchTestNames, bindingOutcome };
