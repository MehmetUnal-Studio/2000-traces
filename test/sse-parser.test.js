// test/sse-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/sse-parser.js';

test('parses a single complete frame', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":1}\n\n');
  assert.deepEqual(out, ['{"t":1}']);
});

test('handles frames split across chunks', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":');
  p.feed('3,"z":5}\n');
  p.feed('\ndata: {"t":0}\n\n');
  assert.deepEqual(out, ['{"t":3,"z":5}', '{"t":0}']);
});

test('ignores comment/other lines, accepts data: without space', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed(': keepalive\n\ndata:{"a":1}\n\n');
  assert.deepEqual(out, ['{"a":1}']);
});

test('handles CRLF line endings', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":2}\r\n\r\n');
  assert.deepEqual(out, ['{"t":2}']);
});

test('handles CRLF split across chunks', () => {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  p.feed('data: {"t":9}\r');
  p.feed('\n\r');
  p.feed('\n');
  assert.deepEqual(out, ['{"t":9}']);
});
