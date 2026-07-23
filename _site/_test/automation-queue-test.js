// Unit tests for the per-project unbounded FIFO gate.

const { createAutomationQueue } = require('../lib/automation-queue');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

(() => {
  const queue = createAutomationQueue();
  assert(queue.tryAcquire('a', 'a1') === true, 'first project A task should acquire');
  assert(queue.tryAcquire('a', 'a2') === false, 'second project A task should wait');
  assert(queue.tryAcquire('b', 'b1') === true, 'project B should run independently');

  for (let index = 2; index <= 50; index += 1) {
    assert(queue.enqueue('a', `a${index}`) === true, `task a${index} should be accepted`);
  }
  assert(queue.size('a') === 49, 'queue should retain every pending commit without a legacy cap');

  for (let index = 2; index <= 50; index += 1) {
    assert(queue.releaseAndNext('a') === `a${index}`, `FIFO should promote a${index}`);
  }
  assert(queue.releaseAndNext('a') === null, 'project A queue should finish empty');
  assert(queue.isActive('a') === false, 'project A slot should be released');
  assert(queue.isActive('b') === true, 'project B slot should remain independent');
  assert(queue.releaseAndNext('b') === null, 'project B should release cleanly');

  const drain = createAutomationQueue();
  drain.tryAcquire('project', 'active');
  drain.enqueue('project', 'queued-1');
  drain.enqueue('project', 'queued-2');
  const dropped = drain.drain('project');
  assert(JSON.stringify(dropped) === JSON.stringify(['queued-1', 'queued-2']), 'drain should return queued tasks in order');
  assert(drain.isActive('project') === true, 'drain should not abort the active task');

  console.log('automation-queue-test PASS');
})();
