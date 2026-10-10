import { loadEnvFile } from 'node:process';
import fs from 'node:fs';
import OpenAI from 'openai';

if (fs.existsSync('.env')) loadEnvFile('.env');

const BASE_URL = 'https://litellm.vision.aivar.app/v1';
const apiKey = process.env.LITELLM_API_KEY ?? '';

const client = new OpenAI({ apiKey, baseURL: BASE_URL });

console.log('--- claude-haiku tiny call ---');
const haikuResp = await client.chat.completions.create({
  model: 'claude-haiku',
  messages: [{ role: 'user', content: 'Reply with: ok' }],
  max_tokens: 20,
});
console.log('model:', haikuResp.model);
console.log('content:', haikuResp.choices[0]?.message?.content);
console.log('usage:', JSON.stringify(haikuResp.usage));
console.log('top-level keys:', Object.keys(haikuResp).join(', '));

console.log('\n--- claude-sonnet-4.6 tiny call ---');
const sonnetResp = await client.chat.completions.create({
  model: 'claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'Reply with: ok' }],
  max_tokens: 20,
});
console.log('model:', sonnetResp.model);
console.log('content:', sonnetResp.choices[0]?.message?.content);
console.log('usage:', JSON.stringify(sonnetResp.usage));
console.log('top-level keys:', Object.keys(sonnetResp).join(', '));

// Test structured JSON output with response_format
console.log('\n--- JSON mode test (haiku) ---');
try {
  const jsonResp = await client.chat.completions.create({
    model: 'claude-haiku',
    messages: [
      { role: 'system', content: 'You output only valid JSON.' },
      { role: 'user', content: 'Return {"test": true}' },
    ],
    max_tokens: 20,
    response_format: { type: 'json_object' },
  });
  console.log('JSON mode supported. content:', jsonResp.choices[0]?.message?.content);
} catch (err: any) {
  console.log('JSON mode NOT supported:', err?.message ?? String(err));
}
