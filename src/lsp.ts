// Language servers in the editor: completion, hover, signature help, go to definition, find
// references, rename and diagnostics from Pyright, jdtls, typescript-language-server and others.
// The Rust side starts the server and passes messages; @codemirror/lsp-client speaks the protocol.
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  LSPClient, LSPPlugin, Workspace, formatDocument, hoverTooltips, jumpToDefinition,
  serverCompletionSource, signatureHelp, type Transport, type WorkspaceFile,
} from '@codemirror/lsp-client'
import { ChangeSet, StateEffect, StateField, Text, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView, type Panel, ViewPlugin, type ViewUpdate, WidgetType, keymap, showDialog, showPanel } from '@codemirror/view'
import type { Diagnostic as EditorDiagnostic } from '@codemirror/lint'
import { relint } from './relint'
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

/** The server family for a file, and the language id LSP expects. */
export function lspLanguage(path: string): { server: string; id: string } | null {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? ''
  const table: Record<string, [string, string]> = {
    py: ['python', 'python'], pyi: ['python', 'python'], java: ['java', 'java'],
    ts: ['typescript', 'typescript'], tsx: ['typescript', 'typescriptreact'], mts: ['typescript', 'typescript'], cts: ['typescript', 'typescript'],
    js: ['typescript', 'javascript'], jsx: ['typescript', 'javascriptreact'], mjs: ['typescript', 'javascript'], cjs: ['typescript', 'javascript'],
    rs: ['rust', 'rust'], go: ['go', 'go'], c: ['cpp', 'c'], h: ['cpp', 'c'], cpp: ['cpp', 'cpp'], cc: ['cpp', 'cpp'], hpp: ['cpp', 'cpp'], cxx: ['cpp', 'cpp'],
  }
  const found = table[ext]
  return found ? { server: found[0], id: found[1] } : null
}

export function toUri(root: string, path: string) {
  const full = root.replace(/\\/g, '/').replace(/\/+$/, '') + (path ? '/' + path : '')
  return 'file://' + (full.startsWith('/') ? full : '/' + full).split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/')
}

export function fromUri(root: string, uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  let path = decodeURIComponent(uri.slice(7))
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^[A-Za-z]:/.test(base)
  const same = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!same(path.slice(0, base.length), base) || path[base.length] !== '/') return null
  return path.slice(base.length + 1)
}

export interface LspHost {
  root: string
  /** For a project on a server: the saved host's id (the server runs there, over SSH). */
  remote?: string | null
  /** Opens a project file in the editor (for go to definition in another file). */
  open: (path: string) => Promise<void>
  /** Changes a file that has no editor showing it: an open tab in the background, or the file on disk. */
  editFile: (path: string, edit: (text: string) => string) => Promise<void>
  /** Reports the outcome of something that runs in the background (a rename). */
  notify: (message: string) => void
  /** A project file's text: the open tab's, or what's on disk. */
  read: (path: string) => Promise<string>
}

// ---- Workspace: one entry per file, any number of editors on it (the split editor) ----
class StillFile implements WorkspaceFile {
  views: EditorView[] = []
  constructor(readonly uri: string, readonly languageId: string, public version: number, public doc: Text) {}
  getView(main?: EditorView) { return main && this.views.includes(main) ? main : this.views.find(view => view.hasFocus) ?? this.views[0] ?? null }
}

type LspEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }
function applyEdits(text: string, edits: LspEdit[]) {
  const doc = Text.of(text.split('\n'))
  const changes = edits.map(edit => ({ from: positionIn(doc, edit.range.start), to: positionIn(doc, edit.range.end), insert: edit.newText }))
  return ChangeSet.of(changes, doc.length).apply(doc).toString()
}

class StillWorkspace extends Workspace {
  files: StillFile[] = []
  private stale = new WeakSet<EditorView>()
  constructor(client: LSPClient, readonly host: LspHost) { super(client) }

  syncFiles() {
    const updates = []
    for (const file of this.files) {
      // The editor being typed in is the one the server follows; the other pane catches up.
      const source = file.views.find(view => view.hasFocus) ?? file.views[0]
      if (!source) continue
      const doc = source.state.doc
      if (!doc.eq(file.doc)) {
        const plugin = LSPPlugin.get(source)
        const changes = plugin && !this.stale.has(source) && plugin.unsyncedChanges.length === file.doc.length
          ? plugin.unsyncedChanges
          : ChangeSet.of([{ from: 0, to: file.doc.length, insert: doc }], file.doc.length)
        updates.push({ file, prevDoc: file.doc, changes })
        file.doc = doc
        file.version++
      }
      for (const view of file.views) {
        if (view.state.doc.eq(file.doc)) { LSPPlugin.get(view)?.clear(); this.stale.delete(view) }
        else this.stale.add(view)
      }
    }
    return updates
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const known = this.files.find(file => file.uri === uri)
    if (known) { if (!known.views.includes(view)) known.views.push(view); if (!view.state.doc.eq(known.doc)) this.stale.add(view); return }
    const file = new StillFile(uri, languageId, 0, view.state.doc)
    file.views.push(view)
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.files.find(item => item.uri === uri)
    if (!file) return
    file.views = file.views.filter(item => item !== view)
    if (!file.views.length) {
      this.files = this.files.filter(item => item !== file)
      if (this.client.connected) this.client.didClose(uri)
    }
  }

  async displayFile(uri: string) {
    const path = fromUri(this.host.root, uri)
    if (path === null) return null
    await this.host.open(path)
    // The editor mounts on the next render or two.
    for (let frame = 0; frame < 60; frame++) {
      const view = this.files.find(file => file.uri === uri)?.getView()
      if (view) return view
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    return null
  }
}

// ---- Diagnostics: kept here and read by the editor's linter, alongside Still's own checks ----
interface Published { doc: Text; items: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number; tags?: number[] }[] }
const published = new Map<string, Published>()

function positionIn(doc: Text, position: { line: number; character: number }) {
  if (position.line >= doc.lines) return doc.length
  const line = doc.line(position.line + 1)
  return Math.min(line.to, line.from + position.character)
}

/** The server's diagnostics for the file in this editor, mapped through edits made since. */
export function serverDiagnostics(view: EditorView): EditorDiagnostic[] | null {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return null
  const entry = published.get(plugin.uri)
  if (!entry) return null
  const doc = view.state.doc
  const map = plugin.syncedDoc === entry.doc ? (pos: number) => plugin.unsyncedChanges.mapPos(pos) : (pos: number) => Math.min(pos, doc.length)
  const found: EditorDiagnostic[] = []
  for (const item of entry.items) {
    // "Unnecessary" hints (an unused import, say) would cover the file in squiggles; leave them out.
    if ((item.severity ?? 1) >= 4) continue
    const from = map(positionIn(entry.doc, item.range.start))
    let to = map(positionIn(entry.doc, item.range.end))
    if (to <= from) to = Math.min(doc.length, from + 1)
    const severity = item.severity === 2 ? 'warning' : item.severity === 3 ? 'info' : 'error'
    found.push({ from, to, severity, message: item.message + (item.code !== undefined && item.code !== '' ? ` (${item.code})` : ''), source: item.source ?? 'server',
      actions: plugin.client.serverCapabilities?.codeActionProvider ? [{ name: 'Quick fix…', apply: () => { window.dispatchEvent(new CustomEvent('still-quick-fix')) } }] : undefined })
  }
  return found
}

// ---- The connection ----
export interface Server { id: string; name: string; language: string; client: LSPClient; close: () => void
  /** Tells the server about files created, changed or deleted on disk (it reads closed files itself). */
  filesChanged: (changes: { path: string; type: 'created' | 'changed' | 'deleted' }[]) => void
}

function sanitize(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const node of template.content.querySelectorAll('script, style, iframe, object, embed, link, meta, form')) node.remove()
  for (const node of template.content.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || (/^(href|src)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name)
    }
  }
  return template.innerHTML
}

/** Starts (or reuses) the server for a language. Resolves to null when none is installed. */
export async function startServer(host: LspHost, language: string, onExit: (log: string) => void): Promise<Server | null> {
  const started = host.remote
    ? await invoke<{ id: string; name: string }>('ssh_lsp_start', { id: host.remote, root: host.root, language })
    : await invoke<{ id: string; name: string } | null>('lsp_start', { rootPath: host.root, language })
  if (!started) return null
  const rootUri = toUri(host.root, '')
  const canonical = (uri: string) => { const path = fromUri(host.root, uri); return path === null ? uri : toUri(host.root, path) }
  const handlers = new Set<(value: string) => void>()
  const folderName = host.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project'
  let opened = false
  const send = (message: string) => {
    // The client library sends only rootUri; most servers (Pyright among them) index the
    // project only when they're also given it as a workspace folder.
    if (!opened && message.includes('"initialize"')) {
      try {
        const value = JSON.parse(message)
        if (value.method === 'initialize') {
          opened = true
          value.params.rootPath = host.root
          value.params.workspaceFolders = [{ uri: rootUri, name: folderName }]
          value.params.capabilities.workspace = { ...(value.params.capabilities.workspace ?? {}), workspaceFolders: true, configuration: true, applyEdit: true, workspaceEdit: { documentChanges: true }, symbol: {} }
          value.params.capabilities.textDocument = { ...(value.params.capabilities.textDocument ?? {}), inlayHint: {},
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } }, isPreferredSupport: true, resolveSupport: { properties: ['edit'] }, dataSupport: true } }
          // typescript-language-server only sends hints it's asked for.
          if (language === 'typescript') value.params.initializationOptions = { ...(value.params.initializationOptions ?? {}), preferences: { includeInlayParameterNameHints: 'literals', includeInlayFunctionLikeReturnTypeHints: true, includeInlayVariableTypeHints: false } }
          message = JSON.stringify(value)
        }
      } catch { /* send as it is */ }
    }
    void invoke('lsp_send', { id: started.id, message }).catch(() => {})
  }
  // Requests from the server that the client library doesn't answer itself.
  const answer = (method: string, params: { items?: unknown[] }): unknown => {
    switch (method) {
      case 'workspace/configuration': return (params?.items ?? []).map(() => null)
      case 'workspace/workspaceFolders': return [{ uri: rootUri, name: folderName }]
      case 'client/registerCapability': case 'client/unregisterCapability': case 'window/workDoneProgress/create': case 'window/showMessageRequest': return null
      case 'workspace/diagnostic/refresh': case 'workspace/semanticTokens/refresh': case 'workspace/inlayHint/refresh': case 'workspace/codeLens/refresh': return null
      default: return undefined
    }
  }
  let client: LSPClient | null = null
  const stops: Promise<UnlistenFn>[] = [
    listen<{ id: string; message: string }>('lsp-message', ({ payload }) => {
      if (payload.id !== started.id) return
      // Servers spell file URIs their own way (on Windows often file:///c%3A/…); use one spelling
      // so files match up with the editors that have them open.
      const text = payload.message.includes('file://') ? payload.message.replace(/"(file:\/\/[^"\\]*)"/g, (_match, uri: string) => '"' + canonical(uri) + '"') : payload.message
      if (text.includes('"method"') && text.includes('"id"')) {
        try {
          const value = JSON.parse(text)
          if (value && 'id' in value && 'method' in value && value.method === 'workspace/applyEdit' && client) {
            // The server asks for an edit (after a quick fix's command, say).
            void applyWorkspaceEdit(client.workspace as StillWorkspace, value.params?.edit ?? {}, 'input.fix')
              .then(() => send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { applied: true } })))
              .catch(error => send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { applied: false, failureReason: String(error) } })))
            return
          }
          if (value && 'id' in value && 'method' in value) {
            const result = answer(value.method, value.params)
            if (result !== undefined) { send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result })); return }
          }
        } catch { return }
      }
      for (const handler of handlers) handler(text)
    }),
    listen<{ id: string; log: string }>('lsp-exit', ({ payload }) => {
      if (payload.id !== started.id) return
      client?.disconnect()
      onExit(payload.log)
    }),
  ]
  await Promise.all(stops)
  const transport: Transport = { send, subscribe: handler => { handlers.add(handler) }, unsubscribe: handler => { handlers.delete(handler) } }
  client = new LSPClient({
    rootUri,
    timeout: 15000,
    sanitizeHTML: sanitize,
    workspace: lspClient => new StillWorkspace(lspClient, host),
    // Diagnostics are handled below rather than by the client's own extension, so say we take them:
    // some servers (typescript-language-server) only publish them to clients that do.
    extensions: [{ clientCapabilities: { textDocument: { publishDiagnostics: { versionSupport: true, relatedInformation: true } } } }],
    notificationHandlers: {
      'textDocument/publishDiagnostics': (lspClient, params: { uri: string; diagnostics: Published['items'] }) => {
        const file = lspClient.workspace.getFile(params.uri) as StillFile | null
        if (!file) { published.delete(params.uri); return true }
        published.set(params.uri, { doc: file.doc, items: params.diagnostics })
        for (const view of file.views) relint(view)
        return true
      },
      // Progress and log chatter isn't shown.
      '$/progress': () => true, 'window/logMessage': () => true, 'language/status': () => true, 'language/actionableNotification': () => true,
    },
  })
  client.connect(transport)
  const connected = client
  return {
    id: started.id, name: started.name, language, client: connected,
    filesChanged: changes => {
      if (!changes.length || !connected.connected) return
      const type = { created: 1, changed: 2, deleted: 3 } as const
      try { connected.notification('workspace/didChangeWatchedFiles', { changes: changes.map(change => ({ uri: toUri(host.root, change.path), type: type[change.type] })) }) } catch { /* not connected */ }
    },
    close: () => {
      void connected.request('shutdown', null).catch(() => {}).finally(() => {
        try { connected.notification('exit', null) } catch { /* already gone */ }
        connected.disconnect()
        void invoke('lsp_stop', { id: started.id }).catch(() => {})
      })
      for (const stop of stops) void stop.then(unlisten => unlisten())
    },
  }
}

type WorkspaceEdit = { changes?: Record<string, LspEdit[]>; documentChanges?: { textDocument?: { uri: string }; edits?: LspEdit[]; kind?: string }[] }
/** Applies a server's edit: open editors change in place (undoable), background tabs change and
 *  stay unsaved, and files that aren't open are changed on disk. Returns how many files changed. */
async function applyWorkspaceEdit(workspace: StillWorkspace, edit: WorkspaceEdit, userEvent: string) {
  const byUri = new Map<string, LspEdit[]>()
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) byUri.set(uri, edits)
  for (const change of edit.documentChanges ?? []) if (change.textDocument && change.edits) byUri.set(change.textDocument.uri, [...(byUri.get(change.textDocument.uri) ?? []), ...change.edits])
  let count = 0
  for (const [uri, edits] of byUri) {
    if (!edits.length) continue
    const target = (workspace.getFile(uri) as StillFile | null)?.getView()
    if (target) {
      const doc = target.state.doc
      target.dispatch({ changes: edits.map(item => ({ from: positionIn(doc, item.range.start), to: positionIn(doc, item.range.end), insert: item.newText })), userEvent })
      count++
      continue
    }
    const path = fromUri(workspace.host.root, uri)
    if (path === null) continue
    try { await workspace.host.editFile(path, text => applyEdits(text, edits)); count++ } catch (error) { workspace.host.notify("Couldn't change " + path + ': ' + String(error)) }
  }
  return count
}

// ---- Quick fixes: the server's code actions for the caret's line ----
export interface QuickFix { title: string; kind: string; preferred: boolean; run: () => Promise<void> }
export async function quickFixes(view: EditorView, refactor = false): Promise<QuickFix[] | null> {
  const plugin = LSPPlugin.get(view)
  if (!plugin?.client.serverCapabilities?.codeActionProvider) return null
  const workspace = plugin.client.workspace as StillWorkspace
  plugin.client.sync()
  const range = view.state.selection.main
  const line = view.state.doc.lineAt(range.head)
  // Refactorings act on exactly what's selected (or the caret); fixes on the whole line.
  const start = plugin.toPosition(range.empty && !refactor ? line.from : range.from), end = plugin.toPosition(range.empty && !refactor ? line.to : range.to)
  const diagnostics = (published.get(plugin.uri)?.items ?? []).filter(item => item.range.start.line <= end.line && item.range.end.line >= start.line)
  type Command = { title: string; command: string; arguments?: unknown[] }
  type Action = { title: string; kind?: string; isPreferred?: boolean; edit?: WorkspaceEdit; command?: Command | string; arguments?: unknown[]; data?: unknown; disabled?: unknown }
  const found = await plugin.client.request<object, Action[] | null>('textDocument/codeAction', { textDocument: { uri: plugin.uri }, range: { start, end }, context: refactor ? { diagnostics: [], only: ['refactor'], triggerKind: 1 } : { diagnostics, triggerKind: 1 } })
  const execute = async (command: Command) => { await plugin.client.request('workspace/executeCommand', { command: command.command, arguments: command.arguments }) }
  return (found ?? []).filter(action => !action.disabled && (!refactor || (action.kind ?? '').startsWith('refactor'))).map(action => ({
    title: action.title, kind: action.kind ?? '', preferred: Boolean(action.isPreferred),
    run: async () => {
      // A bare Command, or a CodeAction with an edit and/or a command (resolved first when the server wants that).
      if (typeof action.command === 'string') { await execute({ title: action.title, command: action.command, arguments: action.arguments }); return }
      let full = action
      if (!full.edit && !full.command && plugin.client.serverCapabilities?.codeActionProvider && typeof plugin.client.serverCapabilities.codeActionProvider === 'object' && plugin.client.serverCapabilities.codeActionProvider.resolveProvider) {
        full = await plugin.client.request<Action, Action>('codeAction/resolve', action)
      }
      if (full.edit) await applyWorkspaceEdit(workspace, full.edit, 'input.fix')
      if (full.command && typeof full.command === 'object') await execute(full.command)
    },
  })).sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.kind.startsWith('quickfix')) - Number(a.kind.startsWith('quickfix')))
}

// ---- Inlay hints: parameter names and inferred types, drawn faintly in the code ----
class HintWidget extends WidgetType {
  constructor(readonly text: string, readonly left: boolean, readonly right: boolean) { super() }
  eq(other: HintWidget) { return other.text === this.text && other.left === this.left && other.right === this.right }
  toDOM() { const node = document.createElement('span'); node.className = 'cm-inlay-hint' + (this.left ? ' pad-left' : '') + (this.right ? ' pad-right' : ''); node.textContent = this.text; return node }
  ignoreEvent() { return true }
}
const inlayHints = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  timer: ReturnType<typeof setTimeout> | undefined
  asked = 0
  constructor(readonly view: EditorView) { this.schedule(300) }
  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = this.decorations.map(update.changes)
    if (update.docChanged || update.viewportChanged) this.schedule(update.docChanged ? 700 : 250)
  }
  schedule(delay: number) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.load() }, delay) }
  async load() {
    const plugin = LSPPlugin.get(this.view)
    if (!plugin?.client.serverCapabilities?.inlayHintProvider) return
    const { from, to } = this.view.viewport
    const asked = ++this.asked
    plugin.client.sync()
    const doc = this.view.state.doc
    type Hint = { position: { line: number; character: number }; label: string | { value: string }[]; paddingLeft?: boolean; paddingRight?: boolean }
    let hints: Hint[] | null = null
    try { hints = await plugin.client.request<object, Hint[] | null>('textDocument/inlayHint', { textDocument: { uri: plugin.uri }, range: { start: plugin.toPosition(from), end: plugin.toPosition(to) } }) } catch { return }
    if (asked !== this.asked || this.view.state.doc !== doc) return
    const ranges = (hints ?? []).map(hint => {
      const text = typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join('')
      return Decoration.widget({ widget: new HintWidget(text.length > 40 ? text.slice(0, 39) + '…' : text, Boolean(hint.paddingLeft), Boolean(hint.paddingRight)), side: 1 }).range(positionIn(doc, hint.position))
    }).sort((a, b) => a.from - b.from)
    this.decorations = Decoration.set(ranges, true)
    this.view.dispatch({ effects: [] })
  }
  destroy() { clearTimeout(this.timer) }
}, { decorations: plugin => plugin.decorations })

/** Rename across the project: open editors change in place (undoable), background tabs change
 *  and stay unsaved, and files that aren't open are changed on disk. */
function renameEverywhere(view: EditorView) {
  const plugin = LSPPlugin.get(view)
  const word = view.state.wordAt(view.state.selection.main.head)
  if (!plugin || !word) return false
  const workspace = plugin.client.workspace as StillWorkspace
  const current = view.state.sliceDoc(word.from, word.to)
  const { close, result } = showDialog(view, { label: 'Rename ' + current + ' to', input: { name: 'name', value: current }, focus: true, submitLabel: 'Rename', class: 'cm-lsp-rename-panel' })
  void result.then(async form => {
    view.dispatch({ effects: close })
    const name = (form?.elements.namedItem('name') as HTMLInputElement | null)?.value.trim()
    if (!form || !name || name === current) { view.focus(); return }
    plugin.client.sync()
    type Response = { changes?: Record<string, LspEdit[]>; documentChanges?: { textDocument?: { uri: string }; edits?: LspEdit[]; kind?: string }[] } | null
    let response: Response
    try {
      response = await plugin.client.request<object, Response>('textDocument/rename', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(word.from), newName: name })
    } catch (error) { workspace.host.notify("Couldn't rename: " + ((error as { message?: string }).message ?? String(error))); return }
    if (!response) { workspace.host.notify('Nothing to rename here.'); return }
    const count = await applyWorkspaceEdit(workspace, response, 'rename')
    workspace.host.notify('Renamed ' + current + ' to ' + name + (count > 1 ? ' in ' + count + ' files.' : '.'))
    view.focus()
  })
  return true
}

// ---- Find references: a list under the editor that follows you from file to file ----
interface Reference { uri: string; path: string; line: number; from: number; to: number; text: string }
interface References { title: string; items: Reference[]; selected: number }
const setReferences = StateEffect.define<References | null>()
const referencesField = StateField.define<References | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setReferences)) return effect.value
    return value
  },
  provide: field => showPanel.from(field, list => list ? view => referencesPanel(view, list) : null),
})

async function openReference(view: EditorView, list: References, index: number) {
  const item = list.items[index]
  const plugin = LSPPlugin.get(view)
  if (!item || !plugin) return
  const target = item.uri === plugin.uri ? view : await (plugin.client.workspace as StillWorkspace).displayFile(item.uri)
  if (!target) return
  const doc = target.state.doc
  const line = doc.line(Math.min(item.line, doc.lines))
  target.dispatch({
    selection: { anchor: Math.min(line.to, line.from + item.from), head: Math.min(line.to, line.from + item.to) }, scrollIntoView: true,
    effects: target.state.field(referencesField, false) !== undefined ? setReferences.of({ ...list, selected: index }) : [],
  })
  target.focus()
}

function referencesPanel(view: EditorView, list: References): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-lsp-reference-panel'
  dom.tabIndex = 0
  dom.setAttribute('role', 'listbox')
  dom.setAttribute('aria-label', list.title)
  const head = dom.appendChild(document.createElement('div'))
  head.className = 'cm-lsp-reference-head'
  head.appendChild(document.createElement('span')).textContent = list.title
  const closer = head.appendChild(document.createElement('button'))
  closer.type = 'button'; closer.textContent = 'Close'; closer.title = 'Close (Esc)'
  closer.onclick = () => { view.dispatch({ effects: setReferences.of(null) }); view.focus() }
  const rows: HTMLElement[] = []
  let file = ''
  list.items.forEach((item, index) => {
    if (item.path !== file) {
      file = item.path
      const header = dom.appendChild(document.createElement('div'))
      header.className = 'cm-lsp-reference-file'
      header.textContent = item.path
    }
    const row = dom.appendChild(document.createElement('div'))
    row.className = 'cm-lsp-reference'
    row.setAttribute('role', 'option')
    if (index === list.selected) row.setAttribute('aria-selected', 'true')
    const number = row.appendChild(document.createElement('span'))
    number.className = 'cm-lsp-reference-line'
    number.textContent = String(item.line).padStart(4, ' ')
    const lead = item.text.length - item.text.trimStart().length
    const start = Math.max(lead, item.from - 60)
    row.appendChild(document.createTextNode(item.text.slice(start, item.from)))
    row.appendChild(document.createElement('strong')).textContent = item.text.slice(item.from, item.to)
    row.appendChild(document.createTextNode(item.text.slice(item.to, item.to + 100)))
    row.onmousedown = event => { event.preventDefault(); void openReference(view, list, index) }
    rows.push(row)
  })
  dom.onkeydown = event => {
    const current = rows.findIndex(row => row.hasAttribute('aria-selected'))
    const move = (next: number) => {
      rows.forEach(row => row.removeAttribute('aria-selected'))
      const index = Math.max(0, Math.min(rows.length - 1, next))
      rows[index]?.setAttribute('aria-selected', 'true')
      rows[index]?.scrollIntoView({ block: 'nearest' })
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(current + 1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(current - 1) }
    else if (event.key === 'Enter') { event.preventDefault(); void openReference(view, list, Math.max(0, current)) }
    else if (event.key === 'Escape') { event.preventDefault(); view.dispatch({ effects: setReferences.of(null) }); view.focus() }
  }
  return { dom, mount: () => rows[list.selected]?.scrollIntoView({ block: 'nearest' }) }
}

function findAllReferences(view: EditorView) {
  const plugin = LSPPlugin.get(view)
  const word = view.state.wordAt(view.state.selection.main.head)
  if (!plugin || !word) return false
  const workspace = plugin.client.workspace as StillWorkspace
  const name = view.state.sliceDoc(word.from, word.to)
  plugin.client.sync()
  type Location = { uri: string; range: LspEdit['range'] }
  void plugin.client.request<object, Location[] | null>('textDocument/references', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(word.from), context: { includeDeclaration: true } }).then(async locations => {
    const texts = new Map<string, Text>()
    const items: Reference[] = []
    for (const location of locations ?? []) {
      const path = fromUri(workspace.host.root, location.uri)
      if (path === null) continue
      let doc = (workspace.getFile(location.uri) as StillFile | null)?.getView()?.state.doc ?? texts.get(path)
      if (!doc) {
        try { doc = Text.of((await workspace.host.read(path)).split('\n')) } catch { continue }
        texts.set(path, doc)
      }
      if (location.range.start.line >= doc.lines) continue
      const line = doc.line(location.range.start.line + 1)
      const end = location.range.end.line === location.range.start.line ? location.range.end.character : line.length
      items.push({ uri: location.uri, path, line: line.number, from: location.range.start.character, to: Math.max(location.range.start.character, end), text: line.text })
    }
    items.sort((a, b) => a.path === b.path ? a.line - b.line || a.from - b.from : a.path.localeCompare(b.path))
    if (!items.length) { workspace.host.notify('No references to ' + name + ' were found.'); return }
    const files = new Set(items.map(item => item.path)).size
    const here = items.findIndex(item => item.uri === plugin.uri && item.line === view.state.doc.lineAt(word.from).number)
    view.dispatch({ effects: setReferences.of({ title: items.length + (items.length === 1 ? ' reference' : ' references') + ' to ' + name + (files > 1 ? ' in ' + files + ' files' : ''), items, selected: Math.max(0, here) }) })
  }, error => workspace.host.notify("Couldn't find references: " + ((error as { message?: string }).message ?? String(error))))
  return true
}

const closeReferences = (view: EditorView) => {
  if (!view.state.field(referencesField, false)) return false
  view.dispatch({ effects: setReferences.of(null) })
  return true
}

/** Symbols anywhere in the project matching a query (functions, classes…), from the server. */
export async function workspaceSymbols(server: Server, root: string, query: string): Promise<{ name: string; kind: number; container: string; path: string; line: number; column: number }[]> {
  type Symbol = { name: string; kind: number; containerName?: string; location: { uri: string; range?: LspEdit['range'] } }
  const found = await server.client.request<object, Symbol[] | null>('workspace/symbol', { query })
  return (found ?? []).flatMap(symbol => {
    const path = fromUri(root, symbol.location.uri)
    if (path === null) return []
    return [{ name: symbol.name, kind: symbol.kind, container: symbol.containerName ?? '', path, line: (symbol.location.range?.start.line ?? 0) + 1, column: (symbol.location.range?.start.character ?? 0) + 1 }]
  }).slice(0, 80)
}

/** What an editor needs to talk to the server about its file. */
export function serverExtension(server: Server, uri: string, languageId: string, hints = true): Extension {
  return [
    server.client.plugin(uri, languageId), hoverTooltips({ hoverTime: 450 }), signatureHelp(), referencesField, hints ? inlayHints : [],
    keymap.of([{ key: 'Shift-F12', run: findAllReferences, preventDefault: true }, { key: 'Escape', run: closeReferences }]),
  ]
}

const capable = (view: EditorView, capability: 'definitionProvider' | 'referencesProvider' | 'renameProvider' | 'completionProvider' | 'documentFormattingProvider') => {
  const plugin = LSPPlugin.get(view)
  return Boolean(plugin?.client.serverCapabilities?.[capability])
}
export const serverCommands = {
  definition: (view: EditorView) => capable(view, 'definitionProvider') && jumpToDefinition(view),
  references: (view: EditorView) => capable(view, 'referencesProvider') && findAllReferences(view),
  rename: (view: EditorView) => capable(view, 'renameProvider') && renameEverywhere(view),
  format: (view: EditorView) => capable(view, 'documentFormattingProvider') && formatDocument(view),
  active: (view: EditorView) => Boolean(LSPPlugin.get(view)?.client.serverCapabilities),
}

/** Still's ranked suggestions, with the server's added: the server knows members, imports and types. */
export function withServer(own: CompletionSource): CompletionSource {
  return async (context: CompletionContext) => {
    const view = context.view
    if (!view || !capable(view, 'completionProvider')) return own(context)
    const [mine, theirs] = await Promise.all([own(context), Promise.resolve(serverCompletionSource(context)).catch(() => null)]) as [CompletionResult | null, CompletionResult | null]
    if (!theirs || !theirs.options.length) return mine
    const afterDot = context.matchBefore(/\.\s*[\w$]*$/) !== null
    const typed = context.state.sliceDoc(theirs.from, context.pos)
    const lower = typed.toLowerCase()
    const fits = (label: string) => !typed || label.toLowerCase().startsWith(lower)
    const server = theirs.options.filter(option => fits(option.label)).map(option => ({ ...option, ['source' as never]: 'server' }))
    // self. / this.: the class's own members first (with the server's types and docs), then the rest of the server's list.
    const ours = afterDot && mine ? mine.options.filter(option => (option as unknown as { member?: boolean }).member) : []
    if (ours.length && mine && mine.from === theirs.from) {
      const labels = new Set(ours.map(option => option.label))
      const merged = [...ours.map(option => { const match = server.find(item => item.label === option.label); return match ? { ...match, ['source' as never]: (option as unknown as { source?: string }).source } : option }), ...server.filter(option => !labels.has(option.label))]
      return { from: mine.from, options: merged.slice(0, 80).map((option, index) => ({ ...option, boost: 99 - Math.min(198, index) })), filter: false }
    }
    // After a dot, the server's list is the accurate one.
    if (afterDot || !mine || mine.from !== theirs.from) return server.length ? { ...theirs, options: server.slice(0, 80), filter: false } : mine
    const labels = new Map(mine.options.map(option => [option.label, option]))
    const extra = server.filter(option => !labels.has(option.label))
    // Fill in types and docs for names both know; keep Still's order, then the server's other names.
    const merged = mine.options.map(option => {
      const match = server.find(item => item.label === option.label)
      return match && (option as { type?: string }).type !== 'snippet' ? { ...match, boost: option.boost, ['source' as never]: (option as unknown as { source?: string }).source || 'server' } : option
    })
    const lowest = Math.min(...merged.map(option => option.boost ?? 0), 0)
    return { from: mine.from, options: [...merged, ...extra.slice(0, 40).map((option, index) => ({ ...option, boost: lowest - 1 - index }))], filter: false }
  }
}
