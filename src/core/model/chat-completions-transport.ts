import type { ModelStreamTerminal, ModelTransport } from './model-transport.js';
import { fields, integer, localSchemaReferences, object, optionalText } from './model-request-validation.js';

const requestFields = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'store',
  'max_completion_tokens', 'max_tokens', 'temperature', 'top_p', 'reasoning_effort', 'parallel_tool_calls'];

function validFunction(value: any, definition: boolean) {
  if (definition) {
    return fields(value, ['name', 'description', 'parameters', 'strict']) && typeof value.name === 'string' &&
      optionalText(value.description) && (value.strict === undefined || typeof value.strict === 'boolean') &&
      (value.parameters === undefined || (object(value.parameters) && localSchemaReferences(value.parameters)));
  }
  return fields(value, ['name', 'arguments']) && typeof value.name === 'string' && typeof value.arguments === 'string';
}

function validMessage(value: any, allowTools: boolean, allowReasoning: boolean) {
  if (!fields(value, ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning']) ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(value.role)) return false;
  if (value.role === 'tool' && (!allowTools || typeof value.tool_call_id !== 'string')) return false;
  if (value.role !== 'tool' && value.tool_call_id !== undefined) return false;
  if (value.tool_calls !== undefined && (!allowTools || value.role !== 'assistant' || !Array.isArray(value.tool_calls) ||
      !value.tool_calls.every((call: any) => fields(call, ['id', 'type', 'function']) && typeof call.id === 'string' &&
        call.type === 'function' && validFunction(call.function, false)))) return false;
  if (!optionalText(value.reasoning_content) || !optionalText(value.reasoning) ||
      (!allowReasoning && (value.reasoning !== undefined || value.reasoning_content !== undefined))) return false;
  return typeof value.content === 'string' || (value.role === 'assistant' && value.content == null) ||
    (Array.isArray(value.content) && value.content.every((part: any) =>
      fields(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string'));
}

function readStream(model: string) {
  let status: ModelStreamTerminal['status'] | undefined;
  let usage: ModelStreamTerminal['usage'];
  let streamId: string | undefined;
  return {
    accept(data: string): ModelStreamTerminal | undefined {
      if (data === '[DONE]') {
        if (!status) throw new Error('Chat Completions stream ended without a finish reason');
        return { status, usage };
      }
      const frame = JSON.parse(data);
      if (object(frame?.error)) throw new Error('Chat Completions upstream returned a stream error');
      if (frame?.model !== model || !Array.isArray(frame.choices) || frame.choices.length > 1 ||
          (frame.id !== undefined && typeof frame.id !== 'string') || (streamId !== undefined && frame.id !== streamId)) {
        throw new Error('Invalid Chat Completions stream frame');
      }
      streamId ??= frame.id;
      for (const choice of frame.choices) {
        if (status || choice?.index !== 0 || !object(choice.delta) ||
            !(choice.finish_reason === null || typeof choice.finish_reason === 'string')) {
          throw new Error('Invalid Chat Completions choice');
        }
        const { content, tool_calls: calls } = choice.delta;
        if ((content != null && typeof content !== 'string') || (calls !== undefined &&
            (!Array.isArray(calls) || !calls.every((call: any) => object(call) && integer(call.index) &&
              optionalText(call.id) && (call.type === undefined || call.type === 'function') &&
              (call.function === undefined || (object(call.function) &&
                optionalText(call.function.name) && optionalText(call.function.arguments))))))) {
          throw new Error('Invalid Chat Completions delta');
        }
        switch (choice.finish_reason) {
          case 'stop':
          case 'tool_calls': status = 'completed'; break;
          case 'length': status = 'incomplete'; break;
          case 'content_filter': status = 'failed'; break;
          case null: break;
          default: throw new Error('Unsupported Chat Completions finish reason');
        }
      }
      if (frame.usage != null) {
        if (usage || !status || !integer(frame.usage.prompt_tokens) || !integer(frame.usage.completion_tokens)) {
          throw new Error('Invalid Chat Completions usage');
        }
        usage = { inputTokens: frame.usage.prompt_tokens, outputTokens: frame.usage.completion_tokens };
      }
    },
  };
}

export const chatCompletionsTransport: ModelTransport = {
  id: 'chat-completions',
  version: '1',
  clientProtocol: 'chat-completions',
  path: '/v1/chat/completions',
  validateUpstream(url) { return url.pathname.endsWith('/v1/chat/completions'); },
  prepareRequest(value: unknown, { model, maxOutputTokens, capabilities }) {
    const body = value as any;
    if (!fields(body, requestFields) || body.model !== model || !Array.isArray(body.messages) || !body.messages.length ||
        !body.messages.every((message: any) => validMessage(message, capabilities?.tools !== false, capabilities?.reasoning !== false)) ||
        (body.stream !== undefined && body.stream !== true) ||
        (body.store !== undefined && body.store !== false) ||
        (body.stream_options !== undefined && !(fields(body.stream_options, ['include_usage']) &&
          typeof body.stream_options.include_usage === 'boolean')) ||
        (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) ||
        ![body.max_tokens, body.max_completion_tokens].every(limit => limit === undefined || integer(limit, 1)) ||
        ![body.temperature, body.top_p].every(option => option === undefined || typeof option === 'number' && Number.isFinite(option)) ||
        !optionalText(body.reasoning_effort) || (capabilities?.reasoning === false && body.reasoning_effort !== undefined) ||
        (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') ||
        (body.tools !== undefined && (capabilities?.tools === false || !Array.isArray(body.tools) ||
          !body.tools.every((tool: any) => fields(tool, ['type', 'function']) && tool.type === 'function' && validFunction(tool.function, true)))) ||
        (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice) &&
          !(fields(body.tool_choice, ['type', 'function']) && body.tool_choice.type === 'function' &&
            fields(body.tool_choice.function, ['name']) && typeof body.tool_choice.function.name === 'string'))) return null;
    if (capabilities?.tools === false && (body.parallel_tool_calls !== undefined ||
        (body.tool_choice !== undefined && body.tool_choice !== 'none'))) return null;
    const field = body.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
    const max = maxOutputTokens === null ? body[field] : Math.min(body[field] ?? maxOutputTokens, maxOutputTokens);
    return { ...body, stream: true, ...(max === undefined ? {} : { [field]: max }) };
  },
  stream: readStream,
};
