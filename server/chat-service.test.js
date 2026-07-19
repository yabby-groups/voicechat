import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory } from './chat-service.js';

test('normalizeHistory keeps only chat roles and bounds message text', () => {
  const output = normalizeHistory([
    { role: 'system', text: 'hidden' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'welcome' },
    { role: 'user', text: 'x'.repeat(5000) },
  ]);
  assert.deepEqual(output.slice(0, 2), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'welcome' },
  ]);
  assert.equal(output[2].content.length, 4000);
});

test('normalizeHistory returns no records for invalid input', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory([{ role: 'user' }]), []);
});
