/**
 * Smoke test for neatlogs SDK integration.
 * Name: scripts/smoke-neatlogs.ts
 *
 * Verifies that neatlogs initializes from environment, records a WORKFLOW
 * trace with a nested custom span without model calls, prints the trace ID,
 * flushes, and shuts down cleanly.
 *
 * Placeholder flag: No placeholder credentials or dummy API keys are used.
 */

import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { init, trace, span, flush, shutdown } from 'neatlogs';

// Environment fallback: check for .env and load if available
if (!process.env.NEATLOGS_API_KEY && fs.existsSync('.env')) {
  try {
    loadEnvFile('.env');
  } catch {
    // Graceful fallback if .env cannot be loaded
  }
}

async function runSmokeTest(): Promise<void> {
  // Initialize neatlogs from environment
  await init({
    workflowName: 'foreman-smoke-test',
  });

  let traceId = '';

  // Record one WORKFLOW trace
  await trace(
    {
      name: 'foreman-smoke-workflow',
      kind: 'WORKFLOW',
    },
    async (workflowSpan) => {
      traceId = workflowSpan.spanContext().traceId;

      // Nested custom span that performs no model call
      const executeCustomSpan = span(
        {
          name: 'foreman-smoke-custom-span',
          kind: 'TOOL',
          description: 'Custom span performing local work with no model calls',
        },
        async () => {
          const executionTime = Date.now();
          return { status: 'success', executionTime };
        }
      );

      await executeCustomSpan();
    }
  );

  console.log(`Trace ID: ${traceId}`);

  // Flush pending spans
  await flush();

  // Shut down SDK
  await shutdown();
}

runSmokeTest().catch((error: unknown) => {
  console.error('Smoke test failure:', error);
  process.exit(1);
});
