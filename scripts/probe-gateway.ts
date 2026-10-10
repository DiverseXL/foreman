/**
 * Gateway probe (Step 5 pre-flight).
 *
 * - Makes ONE tiny real completion call (max 20 tokens) to claude-haiku and claude-sonnet-4.6.
 * - Performs ONE raw HTTP POST to inspect exact response headers and body fields.
 * - Tests whether the gateway supports structured JSON output (response_format: json_object).
 *
 * Never prints the API key. Loads .env only if the key is not already set.
 */

import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import OpenAI from 'openai';

if (!process.env.LITELLM_API_KEY && fs.existsSync('.env')) {
  loadEnvFile('.env');
}

const BASE_URL = (process.env.LITELLM_BASE_URL ?? 'https://litellm.vision.aivar.app/v1').replace(/\/$/, '');
const apiKey = process.env.LITELLM_API_KEY ?? '';

// Only credential-bearing headers are redacted. The gateway also returns
// non-secret spend/budget amounts and per-call cost; those are shown verbatim.
const redact = (name: string): boolean => /authorization|cookie/i.test(name);

function printHeaders(headers: Headers): void {
  const entries: string[] = [];
  headers.forEach((value, name) => {
    entries.push(`${name}: ${redact(name) ? '[redacted]' : value}`);
  });
  entries.sort();
  for (const line of entries) console.log('  ' + line);
}

async function tinySdkCall(model: string): Promise<void> {
  console.log(`--- tiny call: ${model} (max_tokens 20) ---`);
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 20,
  });
  console.log('  response.model:', resp.model);
  console.log('  content:', JSON.stringify(resp.choices[0]?.message?.content));
  console.log('  usage:', JSON.stringify(resp.usage));
  console.log('  finish_reason:', resp.choices[0]?.finish_reason);
}

async function rawHttpCall(model: string): Promise<void> {
  console.log(`--- raw HTTP POST /chat/completions: ${model} (max_tokens 20) ---`);
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      max_tokens: 20,
    }),
  });
  console.log('  HTTP status:', resp.status, resp.statusText);
  console.log('  response headers:');
  printHeaders(resp.headers);
  const text = await resp.text();
  console.log('  response body (raw):');
  console.log('  ' + text);
  try {
    const parsed = JSON.parse(text);
    console.log('  top-level body keys:', Object.keys(parsed).join(', '));
    if (parsed.usage) console.log('  usage keys:', Object.keys(parsed.usage).join(', '));
  } catch {
    console.log('  (body was not JSON)');
  }
}

async function jsonSchemaTest(model: string): Promise<void> {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  console.log(`--- structured JSON test B (response_format json_schema, strict): ${model} ---`);
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You output only valid JSON.' },
        { role: 'user', content: 'Return an object with a boolean field ok set to true.' },
      ],
      max_tokens: 60,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ok_result',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      },
    });
    const content = resp.choices[0]?.message?.content ?? '';
    console.log('  accepted. content:', JSON.stringify(content));
    try {
      JSON.parse(content);
      console.log('  content is bare JSON: yes');
    } catch {
      console.log('  content is bare JSON: no');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('  REJECTED or errored:', message.split('\n')[0]);
  }
}

async function jsonModeTest(model: string): Promise<void> {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  console.log(`--- structured JSON test A (response_format json_object): ${model} ---`);
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You output only valid JSON.' },
        { role: 'user', content: 'Return {"ok": true}' },
      ],
      max_tokens: 30,
      response_format: { type: 'json_object' },
    });
    const content = resp.choices[0]?.message?.content ?? '';
    console.log('  accepted. content:', JSON.stringify(content));
    try {
      JSON.parse(content);
      console.log('  content is bare JSON: yes');
    } catch {
      console.log('  content is bare JSON: no');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('  REJECTED or errored:', message.split('\n')[0]);
  }
}

async function main(): Promise<void> {
  if (!apiKey) {
    console.log('SKIP: LITELLM_API_KEY not set');
    process.exit(0);
  }
  await tinySdkCall('claude-haiku');
  await tinySdkCall('claude-sonnet-4.6');
  await rawHttpCall('claude-haiku');
  await jsonModeTest('claude-haiku');
  await jsonSchemaTest('claude-haiku');
  await jsonSchemaTest('claude-sonnet-4.6');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('PROBE FAILED:', message);
  process.exit(1);
});
