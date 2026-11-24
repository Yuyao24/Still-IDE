// The assistant behind the Chat island. Three providers share one set of tools:
// Claude through the official Anthropic SDK (tool runner, streamed), GitHub Models
// (OpenAI, Llama, Mistral, DeepSeek… with a GitHub token) and a local model through
// Ollama. Tools that change anything wait for the person's approval. The same providers
// also power inline code suggestions (ghost text, like Copilot).

import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { invoke } from '@tauri-apps/api/core'
import { fetch as appFetch } from '@tauri-apps/plugin-http'
import { desktop } from './bridge'

export type Provider = 'anthropic' | 'ollama' | 'github'
export type Mode = 'ask' | 'agent'
export const claudeModels = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]

export interface AiSettings { provider: Provider; model: string; effort: 'low' | 'medium' | 'high'; ollamaUrl: string; ollamaModel: string; githubModel: string; autoApproveEdits: boolean }

/** What the assistant can do in the open project. The Chat island supplies it. */
export interface AgentHost {
  root: string
  remote: boolean
  activeFile?: { path: string; text: string; selection?: string }
  listFiles: () => Promise<string[]>
  read: (path: string) => Promise<string>
  search: (query: string) => Promise<string>
  write: (path: string, contents: string) => Promise<void>
  run: (command: string) => Promise<string>
  open: (path: string, line?: number) => void
  approve: (request: Approval) => Promise<boolean>
}
export type Approval = { kind: 'edit'; path: string; before: string; after: string } | { kind: 'command'; command: string }

/** Everything the chat shows while a reply is being written. */
export interface Events {
  text: (delta: string) => void
  thinking: (delta: string) => void
  tool: (call: { id: string; name: string; summary: string; state: 'running' | 'done' | 'declined' | 'failed'; detail?: string }) => void
}

export const fetchForAi: typeof fetch = desktop ? (appFetch as typeof fetch) : fetch.bind(window)

// ---- Tools ---------------------------------------------------------------------------

/** Paths come from the model, so they are checked: relative, inside the project, no "..". */
function safePath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A file path is required.')
  const path = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(part => part === '..' || part === '')) throw new Error('Use a path inside the project, like src/app.py.')
  return path
}
const text = (value: unknown, name: string) => { if (typeof value !== 'string') throw new Error(`"${name}" must be text.`); return value }
const lines = (body: string, from?: unknown, to?: unknown) => {
  const all = body.split('\n')
  const start = typeof from === 'number' ? Math.max(1, Math.floor(from)) : 1
  const end = typeof to === 'number' ? Math.min(all.length, Math.floor(to)) : Math.min(all.length, start + 799)
  return all.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n') + (end < all.length ? `\n… (${all.length - end} more lines; ask for a later range)` : '')
}

interface ToolSpec { name: string; description: string; schema: { type: 'object'; properties: Record<string, object>; required?: string[] }; changes: boolean; run: (input: Record<string, unknown>, host: AgentHost, events: Events, id: string) => Promise<string> }

const toolSpecs: ToolSpec[] = [
  {
    name: 'list_files', changes: false,
    description: 'List every file in the open project (paths relative to the project root). Call this first when you need to find where something lives.',
    schema: { type: 'object', properties: {} },
    run: async (_, host) => { const all = await host.listFiles(); return all.slice(0, 3000).join('\n') + (all.length > 3000 ? `\n… and ${all.length - 3000} more` : '') },
  },
  {
    name: 'read_file', changes: false,
    description: 'Read a file from the project, with line numbers. Call this before changing a file, and whenever the answer depends on code you have not seen. Optionally pass a line range for long files.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the project root' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
    run: async (input, host) => lines(await host.read(safePath(input.path)), input.start_line, input.end_line),
  },
  {
    name: 'search_project', changes: false,
    description: 'Search all project files for text (case-insensitive). Call this to find where a function, class or string is used.',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (input, host) => host.search(text(input.query, 'query')),
  },
  {
    name: 'open_in_editor', changes: false,
    description: 'Open a file in the editor for the person, optionally at a line. Use it to show them the code you are talking about.',
    schema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' } }, required: ['path'] },
    run: async (input, host) => { host.open(safePath(input.path), typeof input.line === 'number' ? input.line : undefined); return 'Opened.' },
  },
  {
    name: 'edit_file', changes: true,
    description: 'Change part of an existing file by replacing one exact piece of text with new text. old_text must match the file exactly once (read the file first). The person sees the change and approves it before it is saved.',
    schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string', description: 'Exact text to replace, unique in the file' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
    run: async (input, host) => {
      const path = safePath(input.path), oldText = text(input.old_text, 'old_text'), newText = text(input.new_text, 'new_text')
      const before = await host.read(path)
      const count = before.split(oldText).length - 1
      if (!oldText || count === 0) throw new Error('old_text was not found in ' + path + '. Read the file again and copy the text exactly.')
      if (count > 1) throw new Error('old_text appears ' + count + ' times in ' + path + '. Include more surrounding lines so it is unique.')
      const after = before.replace(oldText, () => newText)
      if (!await host.approve({ kind: 'edit', path, before, after })) return 'DECLINED: The person did not apply this change.'
      await host.write(path, after)
      return 'Saved ' + path + '.'
    },
  },
  {
    name: 'write_file', changes: true,
    description: 'Create a new file, or replace a whole file, with the given contents. Prefer edit_file for small changes to existing files. The person approves it before it is saved.',
    schema: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] },
    run: async (input, host) => {
      const path = safePath(input.path), contents = text(input.contents, 'contents')
      const before = await host.read(path).catch(() => '')
      if (!await host.approve({ kind: 'edit', path, before, after: contents })) return 'DECLINED: The person did not save this file.'
      await host.write(path, contents)
      return 'Saved ' + path + '.'
    },
  },
  {
    name: 'run_command', changes: true,
    description: 'Run a shell command in the project folder and get its output, for example to run tests, install a package or check a build. The person approves each command first. Avoid long-running servers.',
    schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: async (input, host) => {
      const command = text(input.command, 'command').trim()
      if (!command) throw new Error('The command is empty.')
      if (!await host.approve({ kind: 'command', command })) return 'DECLINED: The person chose not to run this command.'
      return host.run(command)
    },
  },
]

function summary(name: string, input: Record<string, unknown>) {
  const path = typeof input.path === 'string' ? input.path : ''
  switch (name) {
    case 'list_files': return 'Listed the project files'
    case 'read_file': return 'Read ' + path
    case 'search_project': return 'Searched for “' + String(input.query ?? '') + '”'
    case 'open_in_editor': return 'Opened ' + path
    case 'edit_file': return 'Edit ' + path
    case 'write_file': return 'Write ' + path
    case 'run_command': return 'Run ' + String(input.command ?? '')
    default: return name
  }
}

function systemPrompt(host: AgentHost, mode: Mode) {
  return [
    'You are the assistant inside Still, a calm desktop code editor. You help the person with the project that is open.',
    `The project is at ${host.remote ? 'a folder on a server reached over SSH: ' : ''}${host.root}. Paths you use are relative to it.`,
    mode === 'agent'
      ? 'You can read, search, edit files and run commands with your tools. Read files before changing them, make focused changes, and say briefly what you changed and why. Every edit and command is shown to the person for approval; if they decline, accept it and suggest another way.'
      : 'You can read and search the project but not change it. When a change would help, show it as a short code block and say which file it belongs in.',
    'Keep answers short and concrete. Use Markdown code blocks with a language for code.',
  ].join('\n')
}

function contextNote(host: AgentHost) {
  const file = host.activeFile
  if (!file) return ''
  const selected = file.selection ? `\nThe person has selected this part of it:\n\`\`\`\n${file.selection.slice(0, 8000)}\n\`\`\`` : ''
  const body = file.text.length < 24000 ? `\nCurrent contents:\n\`\`\`\n${file.text}\n\`\`\`` : ''
  return `\n\n(Open file in the editor: ${file.path}.${selected}${body})`
}

// ---- Claude --------------------------------------------------------------------------

export type ClaudeHistory = Anthropic.Beta.BetaMessageParam[]

/** One reply from Claude, with tools. Returns the updated conversation. */
export async function askClaude(options: { apiKey: string; settings: AiSettings; mode: Mode; history: ClaudeHistory; prompt: string; host: AgentHost; events: Events; signal: AbortSignal }): Promise<ClaudeHistory> {
  const { settings, host, events } = options
  const client = new Anthropic({ apiKey: options.apiKey, dangerouslyAllowBrowser: true, fetch: fetchForAi })
  const specs = toolSpecs.filter(spec => options.mode === 'agent' || !spec.changes)
  const tools = specs.map(spec => betaTool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema,
    eager_input_streaming: true,
    run: async (raw: unknown, context) => {
      const id = context?.toolUseBlock?.id ?? crypto.randomUUID()
      // Inputs stream in eagerly, so they are checked here before anything runs.
      const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
      if (!input || (spec.schema.required ?? []).some(key => !(key in input))) {
        return JSON.stringify({ INVALID_JSON: JSON.stringify(raw) })
      }
      events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'running' })
      try {
        const result = await spec.run(input, host, events, id)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: result.startsWith('DECLINED') ? 'declined' : 'done' })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'failed', detail: message })
        return 'Error: ' + message
      }
    },
  }))
  const messages: ClaudeHistory = [...options.history, { role: 'user', content: options.prompt + contextNote(host) }]
  const fallback = settings.model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
  const runner = client.beta.messages.toolRunner({
    model: settings.model,
    max_tokens: 32000,
    system: [{ type: 'text', text: systemPrompt(host, options.mode), cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: settings.effort },
    tools,
    messages,
    stream: true,
    thread: false,
    max_iterations: 24,
    ...fallback,
  }, { signal: options.signal })

  let last: Anthropic.Beta.BetaMessage | null = null
  let wrote = false
  for await (const stream of runner) {
    let fresh = true
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        // Text from separate steps starts on a new paragraph.
        if (event.delta.type === 'text_delta') { events.text((fresh && wrote ? '\n\n' : '') + event.delta.text); fresh = false; wrote = true }
        else if (event.delta.type === 'thinking_delta') events.thinking(event.delta.thinking)
      }
    }
    last = await stream.finalMessage()
    // A cut-off tool call could pass validation, and a refusal can end mid-call: stop instead of running either.
    if (last.stop_reason === 'max_tokens' && last.content.some(block => block.type === 'tool_use')) throw new Error('The reply was cut off in the middle of a tool call. Try asking for a smaller step.')
    if (last.stop_reason === 'refusal') { events.text('\n\n(Claude declined to continue with this request.)'); break }
  }
  const history = [...runner.params.messages] as ClaudeHistory
  if (last && history.at(-1)?.role !== 'assistant') history.push({ role: 'assistant', content: last.content })
  return history
}

/** A short, readable reason for a failed request. */
export function explain(error: unknown) {
  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Settings → AI.'
  if (error instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.'
  if (error instanceof Anthropic.NotFoundError) return 'That model is not available to this API key.'
  if (error instanceof Anthropic.RateLimitError) return 'Rate limit reached. Wait a moment and try again.'
  if (error instanceof Anthropic.BadRequestError) return 'The request was not accepted: ' + error.message
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection."
  if (error instanceof Anthropic.APIError) return 'Anthropic returned an error (' + error.status + '): ' + error.message
  if (error instanceof Error && error.name === 'AbortError') return 'Stopped.'
  return error instanceof Error ? error.message : String(error)
}

// ---- Ollama --------------------------------------------------------------------------

export interface OllamaMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]; tool_name?: string }

export async function ollamaModels(url: string): Promise<string[]> {
  const response = await fetchForAi(url.replace(/\/$/, '') + '/api/tags')
  if (!response.ok) throw new Error('Ollama answered ' + response.status)
  const body = await response.json() as { models?: { name: string }[] }
  return (body.models ?? []).map(model => model.name)
}

/** One reply from a local Ollama model, with the same tools. Returns the updated conversation. */
export async function askOllama(options: { settings: AiSettings; mode: Mode; history: OllamaMessage[]; prompt: string; host: AgentHost; events: Events; signal: AbortSignal }): Promise<OllamaMessage[]> {
  const { settings, host, events } = options
  if (!settings.ollamaModel) throw new Error('Choose an Ollama model in Settings → AI.')
  const specs = toolSpecs.filter(spec => options.mode === 'agent' || !spec.changes)
  const tools = specs.map(spec => ({ type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.schema } }))
  const messages: OllamaMessage[] = options.history.length ? [...options.history] : [{ role: 'system', content: systemPrompt(host, options.mode) }]
  messages.push({ role: 'user', content: options.prompt + contextNote(host) })
  for (let round = 0; round < 16; round++) {
    const response = await fetchForAi(settings.ollamaUrl.replace(/\/$/, '') + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal,
      body: JSON.stringify({ model: settings.ollamaModel, messages, tools, stream: true }),
    })
    if (!response.ok || !response.body) throw new Error('Ollama answered ' + response.status + '. Is the model pulled and does it support tools?')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '', content = ''
    const calls: NonNullable<OllamaMessage['tool_calls']> = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const chunk = JSON.parse(line) as { message?: { content?: string; thinking?: string; tool_calls?: typeof calls }; error?: string }
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.message?.thinking) events.thinking(chunk.message.thinking)
        if (chunk.message?.content) { events.text((!content && round > 0 ? '\n\n' : '') + chunk.message.content); content += chunk.message.content }
        if (chunk.message?.tool_calls) calls.push(...chunk.message.tool_calls)
      }
    }
    messages.push({ role: 'assistant', content, tool_calls: calls.length ? calls : undefined })
    if (!calls.length) return messages
    for (const call of calls) {
      const spec = specs.find(item => item.name === call.function.name)
      const id = crypto.randomUUID()
      const input = call.function.arguments ?? {}
      if (!spec) { messages.push({ role: 'tool', tool_name: call.function.name, content: 'Error: no such tool.' }); continue }
      events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'running' })
      try {
        const result = await spec.run(input, host, events, id)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: result.startsWith('DECLINED') ? 'declined' : 'done' })
        messages.push({ role: 'tool', tool_name: spec.name, content: result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'failed', detail: message })
        messages.push({ role: 'tool', tool_name: spec.name, content: 'Error: ' + message })
      }
    }
  }
  return messages
}

// ---- GitHub Models -------------------------------------------------------------------
// GitHub's model catalog (the models GitHub Copilot users reach) through its OpenAI-style
// inference API. A GitHub token with the "Models: read" permission is all it needs.

const githubApi = 'https://models.github.ai'
const githubHeaders = (token: string) => ({ authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' })

export interface GithubModel { id: string; name: string; publisher: string; tools: boolean }
export const githubFallbackModels: GithubModel[] = [
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', publisher: 'OpenAI', tools: true },
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', publisher: 'OpenAI', tools: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', publisher: 'OpenAI', tools: true },
  { id: 'openai/o4-mini', name: 'o4-mini', publisher: 'OpenAI', tools: true },
  { id: 'deepseek/DeepSeek-V3-0324', name: 'DeepSeek V3', publisher: 'DeepSeek', tools: false },
  { id: 'meta/Llama-4-Maverick-17B-128E-Instruct-FP8', name: 'Llama 4 Maverick', publisher: 'Meta', tools: false },
  { id: 'mistral-ai/Codestral-2501', name: 'Codestral', publisher: 'Mistral AI', tools: false },
]

export async function githubModels(token: string): Promise<GithubModel[]> {
  const response = await fetchForAi(githubApi + '/catalog/models', { headers: githubHeaders(token) })
  if (response.status === 401 || response.status === 403) throw new Error('GitHub rejected the token. It needs the “Models: read” permission.')
  if (!response.ok) throw new Error('GitHub answered ' + response.status)
  const body = await response.json() as { id: string; name?: string; publisher?: string; capabilities?: string[]; supported_output_modalities?: string[] }[]
  return body.filter(model => !model.supported_output_modalities || model.supported_output_modalities.includes('text'))
    .map(model => ({ id: model.id, name: model.name ?? model.id, publisher: model.publisher ?? '', tools: (model.capabilities ?? []).includes('tool-calling') }))
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }

async function githubError(response: Response) {
  let detail = ''
  try { const body = await response.json() as { error?: { message?: string; code?: string } }; detail = body.error?.message ?? '' } catch { /* not JSON */ }
  if (response.status === 401) return new Error('GitHub rejected the token. Check it in Settings → AI.')
  if (response.status === 403) return new Error('This GitHub token can’t use GitHub Models. Give it the “Models: read” permission.' + (detail ? ' (' + detail + ')' : ''))
  if (response.status === 429) return new Error('GitHub Models rate limit reached. Wait a moment, or pick a lighter model.' + (detail ? ' (' + detail + ')' : ''))
  return new Error('GitHub Models answered ' + response.status + (detail ? ': ' + detail : ''))
}

/** One reply from a GitHub model, with tools when the model supports them. Returns the updated conversation. */
export async function askGithub(options: { token: string; settings: AiSettings; mode: Mode; history: ChatMessage[]; prompt: string; host: AgentHost; events: Events; signal: AbortSignal; tools: boolean }): Promise<ChatMessage[]> {
  const { settings, host, events } = options
  if (!settings.githubModel) throw new Error('Choose a GitHub model in Settings → AI.')
  const specs = options.tools ? toolSpecs.filter(spec => options.mode === 'agent' || !spec.changes) : []
  const tools = specs.map(spec => ({ type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.schema } }))
  const messages: ChatMessage[] = options.history.length ? [...options.history] : [{ role: 'system', content: systemPrompt(host, options.mode) }]
  messages.push({ role: 'user', content: options.prompt + contextNote(host) })
  for (let round = 0; round < 16; round++) {
    const response = await fetchForAi(githubApi + '/inference/chat/completions', {
      method: 'POST', headers: githubHeaders(options.token), signal: options.signal,
      body: JSON.stringify({ model: settings.githubModel, messages, stream: true, ...(tools.length ? { tools } : {}) }),
    })
    if (!response.ok || !response.body) throw await githubError(response)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '', content = ''
    const calls: { id: string; name: string; arguments: string }[] = []
    for (let finished = false; !finished;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { finished = true; break }
        let chunk: { choices?: { delta?: { content?: string | null; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; error?: { message?: string } }
        try { chunk = JSON.parse(data) } catch { continue }
        if (chunk.error) throw new Error(chunk.error.message ?? 'GitHub Models returned an error.')
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) events.thinking(delta.reasoning_content)
        if (delta.content) { events.text((!content && round > 0 ? '\n\n' : '') + delta.content); content += delta.content }
        for (const call of delta.tool_calls ?? []) {
          const slot = calls[call.index] ?? (calls[call.index] = { id: call.id ?? crypto.randomUUID(), name: '', arguments: '' })
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.name += call.function.name
          if (call.function?.arguments) slot.arguments += call.function.arguments
        }
      }
    }
    const made = calls.filter(Boolean)
    messages.push({ role: 'assistant', content: content || null, tool_calls: made.length ? made.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) : undefined })
    if (!made.length) return messages
    for (const call of made) {
      const spec = specs.find(item => item.name === call.name)
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(call.arguments || '{}') } catch { messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: the arguments were not valid JSON.' }); continue }
      if (!spec) { messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: no such tool.' }); continue }
      const id = call.id
      events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'running' })
      try {
        const result = await spec.run(input, host, events, id)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: result.startsWith('DECLINED') ? 'declined' : 'done' })
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        events.tool({ id, name: spec.name, summary: summary(spec.name, input), state: 'failed', detail: message })
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: ' + message })
      }
    }
  }
  return messages
}

// ---- Inline suggestions (ghost text) -----------------------------------------------------

export interface CompleteSettings { provider: Provider; model: string; ollamaUrl: string; githubModel: string }

const completeSystem = 'You are the code completion engine inside a code editor. You are given a file with a <CURSOR> marker. Reply with ONLY the exact text to insert at the cursor: no explanation, no Markdown fences, and never repeat code that is already before or after the cursor. Continue naturally from where the person is typing; when they have just written a function or class signature, write the complete body. Match the file\'s indentation and style. If nothing useful fits, reply with an empty message.'

/** Cleans a model's suggestion: no fences, no echo of the text around the cursor. */
function tidySuggestion(raw: string, prefix: string, suffix: string) {
  let text = raw.replace(/^```[\w+-]*\n?/, '').replace(/\n?```\s*$/, '')
  text = text.replace(/<\/?CURSOR>/g, '')
  // Drop a repeated copy of the current line's start, which models sometimes include.
  const lineStart = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (lineStart.trim() && text.startsWith(lineStart)) text = text.slice(lineStart.length)
  // The editor has already indented the new line; don't indent the first line twice.
  else if (!lineStart.trim() && lineStart) { const lead = /^[ \t]*/.exec(text)![0]; text = text.slice(Math.min(lead.length, lineStart.length)) }
  // Stop where the suggestion runs into the code that already follows the cursor.
  const next = suffix.split('\n').find(line => line.trim())?.trim()
  if (next && next.length > 3) { const at = text.indexOf(next); if (at > 0) text = text.slice(0, at) }
  return text.replace(/\s+$/, '')
}

/** Asks the chosen provider what to insert at the cursor. Returns '' when there's nothing to suggest. */
export async function suggestCode(options: { settings: CompleteSettings; key: string | null; path: string; language: string; prefix: string; suffix: string; signal: AbortSignal }): Promise<string> {
  const { settings, prefix, suffix } = options
  const prompt = `File: ${options.path} (${options.language})\n<file>\n${prefix}<CURSOR>${suffix}\n</file>`
  if (settings.provider === 'ollama') {
    if (!settings.model) return ''
    // Fill-in-the-middle: coding models (qwen2.5-coder, codellama, starcoder2…) take the code after the cursor as `suffix`.
    const response = await fetchForAi(settings.ollamaUrl.replace(/\/$/, '') + '/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal,
      body: JSON.stringify({ model: settings.model, prompt: prefix, suffix, stream: false, options: { num_predict: 256, temperature: 0.2 } }),
    })
    if (!response.ok) return ''
    const body = await response.json() as { response?: string }
    return tidySuggestion(body.response ?? '', prefix, suffix)
  }
  if (!options.key) return ''
  if (settings.provider === 'github') {
    const response = await fetchForAi(githubApi + '/inference/chat/completions', {
      method: 'POST', headers: githubHeaders(options.key), signal: options.signal,
      body: JSON.stringify({ model: settings.githubModel || settings.model, max_tokens: 400, messages: [{ role: 'system', content: completeSystem }, { role: 'user', content: prompt }] }),
    })
    if (!response.ok) throw await githubError(response)
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    return tidySuggestion(body.choices?.[0]?.message?.content ?? '', prefix, suffix)
  }
  const client = new Anthropic({ apiKey: options.key, dangerouslyAllowBrowser: true, fetch: fetchForAi, maxRetries: 0 })
  const haiku = settings.model.startsWith('claude-haiku')
  const message = await client.beta.messages.create({
    model: settings.model,
    max_tokens: 1024,
    system: [{ type: 'text', text: completeSystem, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' },
    // Haiku can skip thinking entirely at low effort, which keeps suggestions quick.
    ...(haiku ? { thinking: { type: 'disabled' as const } } : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
  }, { signal: options.signal })
  if (message.stop_reason === 'refusal') return ''
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return tidySuggestion(text, prefix, suffix)
}

// ---- Keys ----------------------------------------------------------------------------

/** Saved keys: the Anthropic API key and the GitHub token, in the system keychain. */
export const keys = {
  status: async (provider: 'anthropic' | 'github' = 'anthropic') => desktop ? invoke<boolean>('ai_key_status', { provider }) : Boolean(sessionStorage.getItem('still.' + provider + '-key')),
  get: async (provider: 'anthropic' | 'github' = 'anthropic') => desktop ? invoke<string | null>('ai_key_get', { provider }) : sessionStorage.getItem('still.' + provider + '-key'),
  set: async (key: string | null, provider: 'anthropic' | 'github' = 'anthropic') => {
    if (desktop) await invoke('ai_key_set', { provider, key })
    else if (key) sessionStorage.setItem('still.' + provider + '-key', key); else sessionStorage.removeItem('still.' + provider + '-key')
  },
}
