import { useEffect, useMemo, useRef, useState } from 'react'
import { type AgentHost, type AiSettings, type Approval, type ChatMessage, type ClaudeHistory, type Mode, type OllamaMessage, askClaude, askGithub, askOllama, explain, githubFallbackModels, keys } from './ai'
import { renderMarkdown } from './Preview'
import { mod } from './bridge'

type ToolCall = { id: string; name: string; summary: string; state: 'running' | 'done' | 'declined' | 'failed'; detail?: string }
type Pending = { id: string; request: Approval; answer: (ok: boolean) => void }
interface Turn { id: string; role: 'user' | 'assistant'; text: string; thinking?: string; tools: ToolCall[]; error?: string; approvals?: Pending[] }

/** A small line diff for the approval card: removed and added lines with a little context. */
function diffLines(before: string, after: string) {
  const a = before.split('\n'), b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1, endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const out: { kind: ' ' | '-' | '+'; text: string; number: number }[] = []
  for (let i = Math.max(0, start - 2); i < start; i++) out.push({ kind: ' ', text: a[i], number: i + 1 })
  for (let i = start; i <= endA; i++) out.push({ kind: '-', text: a[i], number: i + 1 })
  for (let i = start; i <= endB; i++) out.push({ kind: '+', text: b[i], number: i + 1 })
  for (let i = endA + 1; i < Math.min(a.length, endA + 3); i++) out.push({ kind: ' ', text: a[i], number: i + 1 })
  return { lines: out.slice(0, 80), more: Math.max(0, out.length - 80), added: Math.max(0, endB - start + 1), removed: Math.max(0, endA - start + 1) }
}

function ApprovalCard({ pending, onAnswer }: { pending: Pending; onAnswer: (ok: boolean) => void }) {
  const { request } = pending
  if (request.kind === 'command') return <div className="chat-approval">
    <span className="chat-approval-title">Run this command?</span>
    <pre className="chat-command">{request.command}</pre>
    <div className="chat-approval-actions"><button className="text-btn primary" onClick={() => onAnswer(true)} autoFocus>Run</button><button className="text-btn" onClick={() => onAnswer(false)}>Skip</button></div>
  </div>
  const diff = diffLines(request.before, request.after)
  return <div className="chat-approval">
    <span className="chat-approval-title">{request.before ? 'Change' : 'Create'} {request.path} <small>+{diff.added} −{diff.removed}</small></span>
    <pre className="chat-diff">{diff.lines.map((line, index) => <span key={index} className={line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}>{line.kind} {line.text}{'\n'}</span>)}{diff.more ? `… ${diff.more} more lines\n` : ''}</pre>
    <div className="chat-approval-actions"><button className="text-btn primary" onClick={() => onAnswer(true)} autoFocus>Apply</button><button className="text-btn" onClick={() => onAnswer(false)}>Reject</button></div>
  </div>
}

function Reply({ turn, onAnswer }: { turn: Turn; onAnswer: (pending: Pending, ok: boolean) => void }) {
  const html = useMemo(() => turn.text ? renderMarkdown(turn.text) : '', [turn.text])
  const [showThinking, setShowThinking] = useState(false)
  return <div className="chat-turn assistant">
    {turn.thinking && <button className="chat-thinking" onClick={() => setShowThinking(value => !value)} aria-expanded={showThinking}>{showThinking ? 'Hide thinking' : 'Thought about it'}</button>}
    {showThinking && turn.thinking && <p className="chat-thinking-text">{turn.thinking}</p>}
    {turn.tools.map(tool => <div key={tool.id} className={'chat-tool state-' + tool.state} title={tool.detail}>
      <i aria-hidden="true" />{tool.summary}{tool.state === 'declined' && ' · declined'}{tool.state === 'failed' && ' · ' + (tool.detail ?? 'failed')}
    </div>)}
    {turn.approvals?.map(pending => <ApprovalCard key={pending.id} pending={pending} onAnswer={ok => onAnswer(pending, ok)} />)}
    {html && <div className="chat-text doc-markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
      const block = (event.target as Element).closest('pre')
      if (block && (event.target as Element).closest('.chat-copy')) void navigator.clipboard.writeText(block.textContent ?? '')
    }} />}
    {turn.error && <p className="chat-error" role="alert">{turn.error}</p>}
  </div>
}

interface Props {
  settings: AiSettings
  host: Omit<AgentHost, 'approve'>
  projectKey: string
  onSettings: () => void
  onClose: () => void
  focusKey: number
}

/** The Chat island: ask about the project, or let the agent make changes you approve one by one. */
export function Chat({ settings, host, projectKey, onSettings, onClose, focusKey }: Props) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('still.chat.mode') as Mode) || 'agent')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [attach, setAttach] = useState(true)
  const claude = useRef<ClaudeHistory>([])
  const ollama = useRef<OllamaMessage[]>([])
  const github = useRef<ChatMessage[]>([])
  const abort = useRef<AbortController | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  const keyed = settings.provider === 'anthropic' || settings.provider === 'github'
  useEffect(() => { if (settings.provider === 'ollama') { setHasKey(true); return } void keys.status(settings.provider).then(setHasKey).catch(() => setHasKey(false)) }, [settings.provider, focusKey])
  useEffect(() => { try { localStorage.setItem('still.chat.mode', mode) } catch { /* ignore */ } }, [mode])
  useEffect(() => { box.current?.focus() }, [focusKey])
  useEffect(() => { setTurns([]); claude.current = []; ollama.current = []; github.current = [] }, [projectKey])
  useEffect(() => { const node = list.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 160) node.scrollTop = node.scrollHeight }, [turns])

  const update = (id: string, change: (turn: Turn) => Turn) => setTurns(previous => previous.map(turn => turn.id === id ? change(turn) : turn))

  async function send(text = input) {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (keyed && !hasKey) { onSettings(); return }
    setInput('')
    const replyId = crypto.randomUUID()
    setTurns(previous => [...previous, { id: crypto.randomUUID(), role: 'user', text: prompt, tools: [] }, { id: replyId, role: 'assistant', text: '', tools: [] }])
    setBusy(true)
    const controller = new AbortController()
    abort.current = controller
    const agentHost: AgentHost = {
      ...host,
      activeFile: attach ? host.activeFile : undefined,
      approve: request => {
        if (request.kind === 'edit' && settings.autoApproveEdits) return Promise.resolve(true)
        return new Promise<boolean>(resolve => {
          const pending: Pending = { id: crypto.randomUUID(), request, answer: resolve }
          update(replyId, turn => ({ ...turn, approvals: [...(turn.approvals ?? []), pending] }))
          controller.signal.addEventListener('abort', () => resolve(false), { once: true })
        })
      },
    }
    const events = {
      text: (delta: string) => update(replyId, turn => ({ ...turn, text: turn.text + delta })),
      thinking: (delta: string) => update(replyId, turn => ({ ...turn, thinking: (turn.thinking ?? '') + delta })),
      tool: (call: ToolCall) => update(replyId, turn => ({ ...turn, tools: turn.tools.some(item => item.id === call.id) ? turn.tools.map(item => item.id === call.id ? call : item) : [...turn.tools, call] })),
    }
    try {
      if (settings.provider === 'anthropic') {
        const apiKey = await keys.get()
        if (!apiKey) throw new Error('Add your Anthropic API key in Settings → AI.')
        claude.current = await askClaude({ apiKey, settings, mode, history: claude.current, prompt, host: agentHost, events, signal: controller.signal })
      } else if (settings.provider === 'github') {
        const token = await keys.get('github')
        if (!token) throw new Error('Add a GitHub token in Settings → AI.')
        const tools = !githubFallbackModels.some(model => model.id === settings.githubModel && !model.tools) && !/deepseek|llama|codestral|phi-|mistral-small/i.test(settings.githubModel)
        github.current = await askGithub({ token, settings, mode, history: github.current, prompt, host: agentHost, events, signal: controller.signal, tools })
      } else {
        ollama.current = await askOllama({ settings, mode, history: ollama.current, prompt, host: agentHost, events, signal: controller.signal })
      }
    } catch (error) {
      update(replyId, turn => ({ ...turn, error: explain(error) }))
    } finally {
      setBusy(false)
      abort.current = null
      update(replyId, turn => ({ ...turn, approvals: [], tools: turn.tools.map(tool => tool.state === 'running' ? { ...tool, state: 'failed', detail: 'stopped' } : tool) }))
    }
  }

  function answer(pending: Pending, ok: boolean) {
    pending.answer(ok)
    setTurns(previous => previous.map(turn => turn.approvals?.includes(pending) ? { ...turn, approvals: turn.approvals.filter(item => item !== pending) } : turn))
  }

  const modelName = settings.provider === 'anthropic' ? settings.model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^./, c => c.toUpperCase())
    : settings.provider === 'github' ? (settings.githubModel.split('/').at(-1) || 'GitHub Models') : settings.ollamaModel || 'Ollama'
  const file = host.activeFile

  return <div className="chat">
    <div className="island-head chat-head">
      <nav className="under-tabs small" aria-label="Chat mode">
        <button className={mode === 'ask' ? 'is-active' : ''} aria-pressed={mode === 'ask'} onClick={() => setMode('ask')} title="Answers questions; reads files but never changes them">Ask</button>
        <button className={mode === 'agent' ? 'is-active' : ''} aria-pressed={mode === 'agent'} onClick={() => setMode('agent')} title="Can edit files and run commands, each with your approval">Agent</button>
      </nav>
      <span className="chat-head-actions">
        <button onClick={onSettings} title="AI settings">{modelName}</button>
        <button onClick={() => { setTurns([]); claude.current = []; ollama.current = []; github.current = [] }} disabled={busy || !turns.length}>New chat</button>
        <button onClick={onClose} aria-label="Hide chat">Hide</button>
      </span>
    </div>
    <div className="chat-list" ref={list} aria-live="polite">
      {!turns.length && <div className="chat-empty">
        {keyed && hasKey === false ? <>
          <p>{settings.provider === 'github' ? 'Connect GitHub Models with a GitHub token to chat with GPT, Llama, DeepSeek and more about this project.' : 'Connect Claude with your Anthropic API key to chat about this project and let the agent make changes.'}</p>
          <button className="text-btn primary" onClick={onSettings}>{settings.provider === 'github' ? 'Add GitHub token' : 'Add API key'}</button>
        </> : <>
          <p>{mode === 'agent' ? 'Ask for a change. The agent reads the code, then shows each edit and command for you to approve.' : 'Ask about this project. Answers can read your files but never change them.'}</p>
          <div className="chat-suggestions">
            {(mode === 'agent' ? ['Add a test for the open file', 'Explain and fix the last error', 'Add docstrings to this file'] : ['What does this project do?', 'Explain the open file', 'Where is the entry point?']).map(text =>
              <button key={text} onClick={() => { void send(text) }}>{text}</button>)}
          </div>
        </>}
      </div>}
      {turns.map(turn => turn.role === 'user'
        ? <div key={turn.id} className="chat-turn user">{turn.text}</div>
        : <Reply key={turn.id} turn={turn} onAnswer={answer} />)}
      {busy && <span className="chat-working" aria-label="Working"><i /><i /><i /></span>}
    </div>
    <form className="chat-input" onSubmit={event => { event.preventDefault(); void send() }}>
      {file && <button type="button" className={'chat-chip' + (attach ? ' on' : '')} onClick={() => setAttach(value => !value)} aria-pressed={attach} title={attach ? 'The open file is included. Click to leave it out.' : 'Click to include the open file'}>
        {file.path.split('/').at(-1)}{file.selection ? ' · selection' : ''}
      </button>}
      <textarea ref={box} id="chat-input" value={input} rows={Math.min(8, Math.max(2, input.split('\n').length))} placeholder={mode === 'agent' ? 'Ask for a change…' : 'Ask about the code…'}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
      <div className="chat-input-row">
        <span className="help">Enter sends · Shift+Enter new line · {mod}+Shift+A</span>
        {busy ? <button type="button" className="text-btn" onClick={() => abort.current?.abort()}>Stop</button>
          : <button type="submit" className="text-btn primary" disabled={!input.trim()}>Send</button>}
      </div>
    </form>
  </div>
}
