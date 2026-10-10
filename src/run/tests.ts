import { spawnSync } from 'node:child_process';

export interface TestRunResult {
  exitCode: number;
  passed: number;
  failed: number;
  failingTests: string[];
  durationMs: number;
  /** Raw combined stdout/stderr of the test command. */
  output: string;
}

/**
 * Parses machine-readable test output from Node.js test runner (both spec reporter
 * and TAP format). Reporter format verified via direct inspection of node:test in target repo.
 */
export function parseTestOutput(output: string, exitCode = 0): TestRunResult {
  const raw = output;
  let passed = 0;
  let failed = 0;
  let durationMs = 0;
  const failingTests: string[] = [];

  // Check for node:test default spec output
  const specPassMatch = output.match(/ℹ\s+pass\s+(\d+)/);
  const specFailMatch = output.match(/ℹ\s+fail\s+(\d+)/);
  const specDurationMatch = output.match(/ℹ\s+duration_ms\s+([\d.]+)/);

  // Check for TAP format
  const tapPassMatch = output.match(/#\s+pass\s+(\d+)/);
  const tapFailMatch = output.match(/#\s+fail\s+(\d+)/);
  const tapDurationMatch = output.match(/#\s+duration_ms\s+([\d.]+)/);

  if (specPassMatch && specFailMatch) {
    passed = parseInt(specPassMatch[1], 10);
    failed = parseInt(specFailMatch[1], 10);
    durationMs = specDurationMatch ? Math.round(parseFloat(specDurationMatch[1])) : 0;

    // Spec reporter formats failing tests as: ✖ <test_name> (<duration>ms)
    // Both during test execution and in summary section
    const failMatches = [...output.matchAll(/(?:✖|\u2716)\s+([^\r\n(]+?)\s+\([\d.]+ms\)/g)];
    const uniqueFailing = Array.from(new Set(failMatches.map((m) => m[1].trim())));
    failingTests.push(...uniqueFailing);
  } else if (tapPassMatch && tapFailMatch) {
    passed = parseInt(tapPassMatch[1], 10);
    failed = parseInt(tapFailMatch[1], 10);
    durationMs = tapDurationMatch ? Math.round(parseFloat(tapDurationMatch[1])) : 0;

    // TAP format failing tests: not ok <number> - <test_name>
    const tapFailMatches = [...output.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)];
    const uniqueFailing = Array.from(new Set(tapFailMatches.map((m) => m[1].trim())));
    failingTests.push(...uniqueFailing);
  } else {
    // Fallback if structured summary was not detected
    if (exitCode === 0) {
      passed = 1;
      failed = 0;
    } else {
      passed = 0;
      failed = 1;
      failingTests.push('unknown-failure');
    }
  }

  return {
    exitCode,
    passed,
    failed,
    failingTests,
    durationMs,
    output: raw,
  };
}

/**
 * Runs the target's test command in the specified directory with a strict timeout.
 * Respects fail-closed execution and captures machine-readable test output.
 */
export function runTests(directory: string, timeoutMs = 30000): TestRunResult {
  const result = spawnSync('npm test', {
    cwd: directory,
    timeout: timeoutMs,
    encoding: 'utf-8',
    shell: true,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combinedOutput = `${stdout}\n${stderr}`;
  const exitCode = result.status ?? (result.error ? 1 : 0);

  return parseTestOutput(combinedOutput, exitCode);
}
