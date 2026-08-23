import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { SheetsBridgeClient } from '../src/bridge-client.js';

test('bridge request is HMAC signed and cache is only used when requested', async () => {
  const originalFetch = globalThis.fetch;
  const secret = 'x'.repeat(64);
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    const parsed = new URL(url);
    const canonical = [
      parsed.searchParams.get('ts'), parsed.searchParams.get('nonce'),
      parsed.searchParams.get('action'), parsed.searchParams.get('practitioner'),
      parsed.searchParams.get('practice')
    ].join('\n');
    const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    assert.equal(parsed.searchParams.get('signature'), expected);
    return new Response(JSON.stringify({ ok: true, problem: {
      practitionerNo: 1, practitioner: 'Артём', practiceNo: 2,
      tasks: [], students: [], noCandidateTasks: [], diagnostics: {}
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new SheetsBridgeClient('https://example.test/exec', secret, 60_000);
    await client.getProblem(1, 2);
    await client.getProblem(1, 2);
    assert.equal(requests, 1);
    await client.getProblem(1, 2, { fresh: true });
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
