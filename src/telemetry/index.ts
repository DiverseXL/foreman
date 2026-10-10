import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { init, trace, flush, shutdown } from 'neatlogs';
import type { Span } from '@opentelemetry/api';

/**
 * Type declarations relied upon from neatlogs and @opentelemetry/api:
 *
 * node_modules/neatlogs/dist/index.d.ts:
 * - Line 128:
 *   type SpanKind = 'WORKFLOW' | 'AGENT' | 'CHAIN' | 'TOOL' | 'RETRIEVER' | 'EMBEDDING' | 'MCP_TOOL' | 'GUARDRAIL' | 'EVALUATOR';
 * - Line 137:
 *   type TraceSpanKind = SpanKind | 'LLM' | 'RERANKER' | 'VECTOR_STORE';
 * - Line 300-344:
 *   interface TraceOptions {
 *     name: string;
 *     kind?: TraceSpanKind;
 *     sessionId?: string;
 *     attributes?: Record<string, any>;
 *     [key: string]: any;
 *   }
 * - Line 435:
 *   declare function trace<T>(options: TraceOptions, fn: (span: Span$1) => T | Promise<T>): Promise<T>;
 * - Line 454:
 *   declare function init(options?: InitOptions): Promise<void>;
 *
 * node_modules/@opentelemetry/api/build/esm/trace/span.d.ts:
 * - Line 18-38:
 *   export interface Span {
 *     spanContext(): SpanContext;
 *     setAttribute(key: string, value: SpanAttributeValue): this;
 *     setAttributes(attributes: SpanAttributes): this;
 *   }
 */

/**
 * Span kinds accepted by neatlogs trace(). 'LLM' is valid for the lower-level
 * trace() API (TraceSpanKind = SpanKind | 'LLM' | 'RERANKER' | 'VECTOR_STORE').
 */
export type SupportedSpanKind =
  | 'WORKFLOW'
  | 'AGENT'
  | 'CHAIN'
  | 'TOOL'
  | 'RETRIEVER'
  | 'EMBEDDING'
  | 'MCP_TOOL'
  | 'GUARDRAIL'
  | 'EVALUATOR'
  | 'LLM';

let isTelemetryInitialized = false;

/**
 * Initializes neatlogs once from the environment.
 * Loads .env via process.loadEnvFile if NEATLOGS_API_KEY is not already present.
 */
export async function initTelemetry(workflowName = 'foreman'): Promise<void> {
  if (isTelemetryInitialized) {
    return;
  }

  if (!process.env.NEATLOGS_API_KEY && fs.existsSync('.env')) {
    try {
      loadEnvFile('.env');
    } catch {
      // Graceful fallback if .env cannot be loaded
    }
  }

  await init({
    workflowName,
  });

  isTelemetryInitialized = true;
}

/**
 * Creates the root WORKFLOW trace for a Foreman run.
 * Attaches runId and issueId attributes as supported by TraceOptions and Span.
 */
export async function withWorkflow<T>(
  runId: string,
  issueId: string | number,
  fn: (span: Span, traceId: string) => Promise<T>
): Promise<{ result: T; traceId: string }> {
  await initTelemetry('foreman');

  let traceId = '';

  const initialAttributes: Record<string, string | number> = {
    'foreman.run_id': runId,
    'foreman.issue_id': String(issueId),
  };

  const result = await trace(
    {
      name: `foreman-run-${runId}`,
      kind: 'WORKFLOW',
      sessionId: runId,
      attributes: initialAttributes,
    },
    async (span: Span) => {
      traceId = span.spanContext().traceId;
      // Statically supported attribute types in @opentelemetry/api
      span.setAttribute('foreman.run_id', runId);
      span.setAttribute('foreman.issue_id', String(issueId));
      return await fn(span, traceId);
    }
  );

  return { result, traceId };
}

/**
 * Creates a child span of a given kind within the active trace.
 * Allows attaching span attributes (e.g. baseline test counts).
 */
export async function withStage<T>(
  name: string,
  kind: SupportedSpanKind,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return await trace(
    {
      name,
      kind,
      attributes,
    },
    async (span: Span) => {
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }
      }
      return await fn(span);
    }
  );
}

/**
 * Flushes all pending spans.
 */
export async function flushTelemetry(): Promise<boolean> {
  return await flush();
}

/**
 * Gracefully shuts down neatlogs exporter.
 */
export async function shutdownTelemetry(): Promise<boolean> {
  const result = await shutdown();
  isTelemetryInitialized = false;
  return result;
}
