// SPDX-License-Identifier: GPL-3.0-only
// Native Anthropic Messages API adapter. Capri's gateway speaks the OpenAI
// chat-completions dialect; this module translates requests to the Messages
// API through the official SDK and streams the reply back as OpenAI chunks.
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Models that accept the server-side refusal fallback chain.
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const isClaudeEndpoint = (url) => new URL(url).origin === ANTHROPIC_ORIGIN;

class ClaudeRequestError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CAPRI_API_INVALID_REQUEST';
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function imageBlock(url) {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/isu.exec(url);
  if (match)
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  if (/^https:\/\//iu.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw new ClaudeRequestError('Unsupported image reference.');
}

function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string')
      return part.text ? [{ type: 'text', text: part.text }] : [];
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string')
      return [imageBlock(part.image_url.url)];
    if (part?.type === 'input_image' && typeof part.image_url === 'string')
      return [imageBlock(part.image_url)];
    return [];
  });
}

function parseArguments(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Translate an OpenAI chat-completions payload into Messages API parameters. */
export function claudeMessagesRequest(payload, model = DEFAULT_CLAUDE_MODEL) {
  if (!Array.isArray(payload?.messages) || !payload.messages.length)
    throw new ClaudeRequestError('The conversation is empty.');
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const message of payload.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (!text) continue;
      // Leading instructions form the cached system prompt; later ones stay
      // in order as clearly labelled user-side notes.
      if (!messages.length) system.push({ type: 'text', text });
      else push('user', [{ type: 'text', text: `[System note]\n${text}` }]);
    } else if (message.role === 'user') {
      push('user', userBlocks(message.content));
    } else if (message.role === 'assistant') {
      const blocks = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls ?? [])
        if (call?.type === 'function' && typeof call.function?.name === 'string')
          blocks.push({
            type: 'tool_use',
            id: String(call.id),
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          });
      push('assistant', blocks);
    } else if (message.role === 'tool') {
      const output =
        typeof message.content === 'string'
          ? message.content
          : textOf(message.content) || JSON.stringify(message.content ?? '');
      push('user', [
        { type: 'tool_result', tool_use_id: String(message.tool_call_id), content: output },
      ]);
    }
  }
  // The Messages API requires the conversation to open with a user turn.
  if (messages[0]?.role !== 'user')
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  // Prefill is not supported by current models: a trailing assistant turn
  // becomes context followed by an explicit continuation request.
  if (messages.at(-1)?.role === 'assistant')
    messages.push({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  const requested = payload.max_completion_tokens ?? payload.max_tokens;
  const params = {
    model,
    // Thinking shares this budget with the visible reply, so keep headroom.
    max_tokens: Math.max(Number.isFinite(requested) && requested > 0 ? requested : 0, 8192),
    messages,
    cache_control: { type: 'ephemeral' },
  };
  if (system.length) params.system = system;
  const effort = payload.reasoning?.effort ?? payload.reasoning_effort;
  if (EFFORTS.has(effort)) params.output_config = { effort };
  else if (effort === 'minimal' || effort === 'none') params.output_config = { effort: 'low' };
  const stops = [payload.stop].flat().filter((value) => typeof value === 'string' && value.trim());
  if (stops.length) params.stop_sequences = stops.slice(0, 8);
  const tools = (payload.tools ?? [])
    .filter((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string')
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? '',
      input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    }));
  if (tools.length) {
    params.tools = tools;
    // Forced tool choice is rejected by current models; steer with auto.
    params.tool_choice = payload.tool_choice === 'none' ? { type: 'none' } : { type: 'auto' };
  }
  if (FALLBACK_MODELS.has(model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

const FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

async function* completionPackets(events, model) {
  const id = 'chatcmpl-' + randomUUID();
  const packet = (delta, finish_reason = null, usage) => ({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });
  const calls = new Map();
  let input = 0,
    output = 0,
    stop = null,
    first = true;
  for await (const event of events) {
    if (event.type === 'message_start') {
      const usage = event.message?.usage ?? {};
      input =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (first) {
        first = false;
        yield packet({ role: 'assistant', content: '' });
      }
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const call = {
        index: calls.size,
        id: event.content_block.id,
        name: event.content_block.name,
      };
      calls.set(event.index, call);
      yield packet({
        tool_calls: [
          {
            index: call.index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      });
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text)
        yield packet({ content: event.delta.text });
      else if (event.delta?.type === 'input_json_delta') {
        const call = calls.get(event.index);
        if (call && event.delta.partial_json)
          yield packet({
            tool_calls: [{ index: call.index, function: { arguments: event.delta.partial_json } }],
          });
      }
      // Thinking deltas stay private.
    } else if (event.type === 'message_delta') {
      stop = event.delta?.stop_reason ?? stop;
      output = event.usage?.output_tokens ?? output;
    }
  }
  yield packet({}, FINISH[stop] ?? 'stop', {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  });
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502;
  return new Response(JSON.stringify({ error: { message: 'Claude API request failed.' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Send an OpenAI-shaped request to Claude and answer with an OpenAI-shaped
 * Response (SSE when payload.stream is true). HTTP errors from Anthropic are
 * returned as non-OK Responses so the caller's provider error handling applies.
 */
export async function claudeCompletion({ key, payload, model, signal, fetchImpl, client }) {
  const anthropic =
    client ??
    new Anthropic({
      apiKey: key,
      baseURL: ANTHROPIC_ORIGIN,
      maxRetries: 1,
      timeout: 10 * 60 * 1000,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  const params = claudeMessagesRequest(payload, model || DEFAULT_CLAUDE_MODEL);
  const stream = anthropic.beta.messages.stream(params, { signal });
  const iterator = stream[Symbol.asyncIterator]();
  // Wait for the first event so authentication, model and quota errors
  // surface as HTTP statuses before any reply bytes are committed.
  let head;
  try {
    head = await iterator.next();
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError || signal?.aborted) throw error;
    if (error instanceof Anthropic.APIError && error.status) return errorResponse(error);
    throw error;
  }
  async function* events() {
    if (!head.done) yield head.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const packets = completionPackets(events(), params.model);
  if (payload.stream === true) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async pull(target) {
          try {
            const next = await packets.next();
            if (next.done) {
              target.enqueue(encoder.encode('data: [DONE]\n\n'));
              target.close();
            } else target.enqueue(encoder.encode('data: ' + JSON.stringify(next.value) + '\n\n'));
          } catch (error) {
            target.error(error);
          }
        },
        async cancel() {
          stream.abort();
          await packets.return().catch(() => {});
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  let text = '',
    usage,
    finish_reason;
  const calls = new Map();
  for await (const packet of packets) {
    const choice = packet.choices[0];
    text += choice.delta.content ?? '';
    for (const part of choice.delta.tool_calls ?? []) {
      const call = calls.get(part.index) ?? {
        id: part.id,
        type: 'function',
        function: { name: part.function.name, arguments: '' },
      };
      call.function.arguments += part.function.arguments ?? '';
      calls.set(part.index, call);
    }
    usage = packet.usage ?? usage;
    finish_reason = choice.finish_reason ?? finish_reason;
  }
  return Response.json({
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    model: params.model,
    choices: [
      {
        index: 0,
        finish_reason,
        message: {
          role: 'assistant',
          content: text || null,
          ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
        },
      },
    ],
    usage,
  });
}
