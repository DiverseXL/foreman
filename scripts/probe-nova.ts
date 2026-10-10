/**
 * Step-7 validator pre-flight probe.
 *
 * Makes ONE tiny real completion call (max 20 completion tokens) to nova-pro
 * using response_format json_schema (strict), to confirm the independent
 * validator's model works on this gateway before the supervisor depends on it.
 * If it does not work, the validator falls back to claude-haiku.
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

async function main(): Promise<void> {
  if (!apiKey) {
    console.log('SKIP: LITELLM_API_KEY not set');
    process.exit(0);
  }

  const model = process.env.FOREMAN_MODEL_VALIDATOR?.trim() || 'nova-pro';
  console.log(`--- nova probe: ${model} (max_tokens 20, json_schema) ---`);

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  try {
    const { data: resp, response: raw } = await client.chat.completions
      .create({
        model,
        messages: [
          { role: 'system', content: 'You output only valid JSON.' },
          { role: 'user', content: 'Return an object with a boolean field ok set to true.' },
        ],
        max_tokens: 20,
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
      })
      .withResponse();

    const content = resp.choices[0]?.message?.content ?? '';
    console.log('  WORKS: yes');
    console.log('  response.model:', resp.model);
    console.log('  content:', JSON.stringify(content));
    console.log('  usage:', JSON.stringify(resp.usage));
    console.log('  x-litellm-response-cost:', raw.headers.get('x-litellm-response-cost'));
    try {
      JSON.parse(content);
      console.log('  content is bare JSON: yes');
    } catch {
      console.log('  content is bare JSON: no');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('  WORKS: no');
    console.log('  error:', message.split('\n')[0]);
    console.log('  FALLBACK: use claude-haiku for the validator (set FOREMAN_MODEL_VALIDATOR=claude-haiku).');
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('PROBE FAILED:', message);
  process.exit(1);
});
