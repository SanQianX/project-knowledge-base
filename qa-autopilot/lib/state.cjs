'use strict';
// Recover local state without replaying external writes. / 恢复本地状态，不重放外部写入。
const fs = require('node:fs');
const path = require('node:path');
const { must, atomicJSON, readJSON, acquireLock, hash } = require('./safety.cjs');
const edges = {
    INITIALIZING: ['BASELINE_VERIFYING', 'BLOCKED'], BASELINE_VERIFYING: ['DISCOVERING', 'BLOCKED'],
    DISCOVERING: ['REPRODUCING', 'CODE_CLEANUP', 'REGRESSION_TESTING', 'BLOCKED'],
    REPRODUCING: ['TRIAGING', 'DISCOVERING', 'BLOCKED'], TRIAGING: ['FIXING', 'BLOCKED'],
    FIXING: ['VERIFYING', 'BLOCKED'], VERIFYING: ['COMMITTING', 'FIXING', 'BLOCKED'],
    COMMITTING: ['PUSHING', 'BLOCKED'], PUSHING: ['CI_VERIFYING', 'BLOCKED'],
    CI_VERIFYING: ['DISCOVERING', 'REGRESSION_TESTING', 'BLOCKED'],
    CODE_CLEANUP: ['CLEANUP_VERIFYING', 'BLOCKED'], CLEANUP_VERIFYING: ['COMMITTING', 'CODE_CLEANUP', 'BLOCKED'],
    REGRESSION_TESTING: ['DISCOVERING', 'RC_PREPARING', 'BLOCKED'],
    RC_PREPARING: ['RC_PUBLISHING', 'BLOCKED'], RC_PUBLISHING: ['RC_VALIDATING', 'BLOCKED'],
    RC_VALIDATING: ['DISCOVERING', 'READY_FOR_STABLE_APPROVAL', 'BLOCKED'],
    PAUSING: ['PAUSED_QUOTA', 'BLOCKED'], PAUSED_QUOTA: ['RESUMING', 'BLOCKED'],
    RESUMING: [], BLOCKED: [], READY_FOR_STABLE_APPROVAL: []
};
class Store {
    constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'checkpoint.json'); }
    read() { return fs.existsSync(this.file) ? readJSON(this.file) : { schema: 1, revision: 0, phase: 'INITIALIZING', operations: {} }; }
    transact(expectedRevision, fn) {
        const release = acquireLock(path.join(this.dir, 'state.lock'));
        try {
            const old = this.read();
            must(old.revision === expectedRevision, 'STALE_CHECKPOINT', 'Checkpoint revision changed.');
            const next = fn(structuredClone(old));
            next.revision = old.revision + 1;
            next.updatedAt = new Date().toISOString();
            const event = { revision: next.revision, previous: hash(JSON.stringify(old)), next };
            atomicJSON(path.join(this.dir, 'journal', String(next.revision).padStart(8, '0') + '.json'), event, { exclusive: true });
            atomicJSON(this.file, next);
            return next;
        }
        finally {
            release();
        }
    }
    recoverJournal() {
        const release = acquireLock(path.join(this.dir, 'state.lock'));
        try {
            let current = this.read(), recovered = 0;
            const dir = path.join(this.dir, 'journal');
            if (!fs.existsSync(dir))
                return { recovered, checkpoint: current };
            for (const name of fs.readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).sort()) {
                const entry = readJSON(path.join(dir, name));
                if (entry.revision <= current.revision)
                    continue;
                must(entry.revision === current.revision + 1 && entry.next.revision === entry.revision && entry.previous === hash(JSON.stringify(current)), 'JOURNAL_CHAIN', 'Journal gap/hash mismatch; preserve evidence and block.');
                atomicJSON(this.file, entry.next);
                current = entry.next;
                recovered++;
            }
            return { recovered, checkpoint: current, note: 'Journal recovery never repeats external Git/npm operations.' };
        }
        finally {
            release();
        }
    }
    resumeAfterReconciliation(evidence) {
        const s = this.read();
        must(s.phase === 'RESUMING' && s.resumePhase && evidence?.externalStateVerified === true, 'RECONCILIATION_REQUIRED', 'Read actual Git, processes and npm state before resume.');
        return this.transact(s.revision, x => { x.phase = x.resumePhase; delete x.resumePhase; x.evidence = evidence; return x; });
    }
    transition(target, evidence = {}) {
        const s = this.read();
        return this.transact(s.revision, x => {
            const canPause = target === 'PAUSING' && !['COMMITTING', 'PUSHING', 'RC_PUBLISHING', 'PAUSED_QUOTA', 'READY_FOR_STABLE_APPROVAL'].includes(x.phase);
            must(canPause || (edges[x.phase] || []).includes(target), 'ILLEGAL_TRANSITION', `${x.phase} -> ${target} is not permitted.`);
            if (canPause)
                x.resumePhase = x.phase;
            x.phase = target;
            x.evidence = evidence;
            return x;
        });
    }
    beginOperation(id, details) {
        const s = this.read();
        if (s.operations[id])
            return { existing: true, operation: s.operations[id] };
        this.transact(s.revision, x => { x.operations[id] = { status: 'INTENT', details, at: new Date().toISOString() }; return x; });
        return { existing: false };
    }
    completeOperation(id, receipt) {
        const s = this.read();
        return this.transact(s.revision, x => { must(x.operations[id]?.status === 'INTENT', 'NO_INTENT', 'Missing or completed operation.'); x.operations[id] = { ...x.operations[id], status: 'DONE', receipt }; return x; });
    }
}
module.exports = { Store, edges };
