// _site/_test/run-all-tests.js
//
// Single-command regression suite runner. Iterates the canonical test files
// under _site/_test/ (everything matching *-test.js) and runs each one in a
// separate child process, capturing exit code, duration, and the last few
// lines of output. Writes a Markdown report to TEST-REPORT.md.
//
// Usage:
//   node _site/_test/run-all-tests.js                  # run all *-test.js
//   node _site/_test/run-all-tests.js --no-report      # do not write report
//   node _site/_test/run-all-tests.js --include-ui     # also run ui-test.js
//                                                      # (requires Playwright)
//
// Exit code is 0 only if every test passes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = __dirname;
const REPORT_PATH = path.join(TEST_DIR, 'TEST-REPORT.md');

const args = process.argv.slice(2);
const WRITE_REPORT = !args.includes('--no-report');
const INCLUDE_UI = args.includes('--include-ui');

function listTestFiles() {
  return fs.readdirSync(TEST_DIR)
    .filter(file => file.endsWith('-test.js'))
    // Skip legacy ui-test.js by default. ui-smoke-test.js uses local Chrome via
    // CDP and is safe to run as part of the regression suite.
    .filter(file => INCLUDE_UI || file !== 'ui-test.js')
    .filter(file => file !== 'run-all-tests.js')
    .sort();
}

function tail(text, lines = 12) {
  const arr = String(text || '').split(/\r?\n/).filter(Boolean);
  return arr.slice(-lines).join('\n');
}

function runOne(file) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    file,
    passed: result.status === 0,
    exitCode: result.status,
    durationMs: Date.now() - start,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    outputTail: tail(result.stdout || result.stderr),
  };
}

(async () => {
  const files = listTestFiles();
  console.log(`Running ${files.length} test file(s)...\n`);

  const results = [];
  let totalDuration = 0;
  for (const file of files) {
    process.stdout.write(`> ${file} ... `);
    const result = runOne(file);
    totalDuration += result.durationMs;
    results.push(result);

    if (result.passed) {
      console.log(`PASS (${result.durationMs}ms)`);
    } else {
      console.log(`FAIL (exit ${result.exitCode}, ${result.durationMs}ms)`);
      if (result.outputTail) {
        console.log('--- tail ---');
        console.log(result.outputTail);
        console.log('--- end tail ---');
      }
    }
  }

  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;
  console.log('\n=========================================');
  console.log(`Regression suite: ${passed} passed, ${failed} failed (${totalDuration}ms total)`);
  console.log('=========================================\n');

  if (WRITE_REPORT) {
    const lines = [];
    lines.push('# KB Management Site Regression Test Report');
    lines.push('');
    lines.push(`**Generated**: ${new Date().toISOString()}`);
    lines.push(`**Node**: ${process.version}`);
    lines.push('**Runner**: node _site/_test/run-all-tests.js');
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| # | File | Status | Exit | Duration |');
    lines.push('|--:|------|:------:|-----:|---------:|');
    results.forEach((result, index) => {
      const status = result.passed ? 'PASS' : 'FAIL';
      lines.push(`| ${index + 1} | \`${result.file}\` | ${status} | ${result.exitCode} | ${result.durationMs}ms |`);
    });
    lines.push('');
    lines.push(`**Total**: ${results.length} | **Passed**: ${passed} | **Failed**: ${failed} | **Time**: ${totalDuration}ms`);
    lines.push('');

    const failures = results.filter(result => !result.passed);
    if (failures.length) {
      lines.push('## Failures');
      lines.push('');
      for (const result of failures) {
        lines.push(`### ${result.file}`);
        lines.push('');
        lines.push('```');
        lines.push(result.outputTail);
        lines.push('```');
        lines.push('');
      }
    }

    try {
      fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf-8');
      console.log(`Report written to: ${REPORT_PATH}`);
    } catch (e) {
      console.error(`Failed to write report: ${e.message}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
})();
