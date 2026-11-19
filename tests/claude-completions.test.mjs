// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCompletion,
  claudeMessagesRequest,
  isClaudeEndpoint,
} from '../apps/desktop/claude-completions.mjs';

const sse = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

function fakeFetch(body, { status = 200, seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(body, {
      status,
      headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' },
    });
  };
}

const message = (extra = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [],
  stop_reason: null,
  usage: { input_tokens: 10, output_tokens: 0 },
  ...extra,
});

test('recognizes the Anthropic endpoint', () => {
  assert.equal(isClaudeEndpoint('https://api.anthropic.com/v1'), true);
  assert.equal(isClaudeEndpoint('https://api.openai.com/v1'), false);
});

test('translates OpenAI chat payloads to Messages API parameters', () => {
  const params = claudeMessagesRequest(
    {
      messages: [
        { role: 'system', content: 'You are Capri.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{"a":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
      ],
      tools: [{ type: 'function', function: { name: 'clock', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      max_tokens: 1024,
      temperature: 0.7,
      reasoning: { effort: 'low' },
    },
    'claude-opus-5-5',
  );
  assert.deepEqual(params.system, [{ type: 'text', text: 'You are Capri.' }]);
  assert.equal(params.messages[0].role, 'user');
  assert.equal(params.messages[0].content[1].type, 'image');
  assert.equal(params.messages[0].content[1].source.media_type, 'image/png');
  assert.deepEqual(params.messages[1].content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'clock',
    input: { a: 1 },
  });
  assert.equal(params.messages[2].content[0].type, 'tool_result');
  assert.deepEqual(params.tool_choice, { type: 'auto' });
  assert.equal(params.temperature, undefined);
  assert.ok(params.max_tokens >= 8192);
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(params.fallbacks, 'default');
});

test('streams Claude replies as OpenAI chunks', async () => {
  const seen = [];
  const body = sse([
    { type: 'message_start', message: message() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'clock', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"zone":"CET"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]);
  const response = await claudeCompletion({
    key: 'sk-ant-test',
    payload: { stream: true, messages: [{ role: 'user', content: 'hello' }] },
    model: 'claude-opus-5-5',
    fetchImpl: fakeFetch(body, { seen }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const packets = text
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(packets.map((p) => p.choices[0].delta.content ?? '').join(''), 'Hi there');
  const call = packets.flatMap((p) => p.choices[0].delta.tool_calls ?? []);
  assert.equal(call[0].function.name, 'clock');
  assert.equal(call.map((c) => c.function.arguments).join(''), '{"zone":"CET"}');
  assert.equal(packets.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(packets.at(-1).usage.completion_tokens, 7);
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
  assert.equal(new URL(seen[0].url).pathname, '/v1/messages');
  const headers = new Headers(seen[0].init.headers);
  assert.ok(
    headers.get('x-api-key') === 'sk-ant-test' ||
      headers.get('authorization') === 'Bearer sk-ant-test',
  );
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(seen[0].body.betas, undefined);
  assert.equal(seen[0].body.model, 'claude-opus-5-5');
});

test('returns a non-streaming completion', async () => {
  const body = sse([
    { type: 'message_start', message: message() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
  const response = await claudeCompletion({
    key: 'sk-ant-test',
    payload: { messages: [{ role: 'user', content: 'hello' }] },
    fetchImpl: fakeFetch(body),
  });
  const packet = await response.json();
  assert.equal(packet.choices[0].message.content, 'OK');
  assert.equal(packet.choices[0].finish_reason, 'stop');
});

test('maps provider errors to HTTP statuses', async () => {
  const response = await claudeCompletion({
    key: 'sk-ant-bad',
    payload: { stream: true, messages: [{ role: 'user', content: 'hello' }] },
    fetchImpl: fakeFetch(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
      { status: 401 },
    ),
  });
  assert.equal(response.status, 401);
  assert.equal(response.ok, false);
});
