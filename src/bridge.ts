import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import appSource from '../src-tauri/sample/app.py?raw'
import javaSource from '../src-tauri/sample/Main.java?raw'
import readme from '../src-tauri/sample/README.md?raw'
import orbitTest from '../src-tauri/sample/test_orbit.py?raw'
import requirements from '../src-tauri/sample/requirements.txt?raw'
import gitignore from '../src-tauri/sample/gitignore.txt?raw'

export interface Workspace { root: string; name: string; sample?: boolean; remote?: string; hostName?: string }
export interface Entry { name: string; path: string; directory: boolean }
export interface Runtimes { python: string | null; pythonVenv: boolean; java: string | null; node?: string | null; git?: string | null; ssh?: string | null; shell: string }
export interface ProjectSummary {
  name: string; path: string; location: 'library' | 'external'; lastOpened: number | null; modified: number | null
  languages: string[]; branch: string | null; description: string | null; pinned: boolean; missing: boolean
}
export interface HomeState { projectsRoot: string | null; suggestedRoot: string; projects: ProjectSummary[] }
export interface SshHost {
  id: string; name: string; host: string; address?: string | null; user?: string | null; port?: number | null
  identityFile?: string | null; jump?: string | null; forwards: string[]; remotePath?: string | null; lastUsed?: number | null; source: 'saved' | 'config'
}
export interface SshOverview { saved: SshHost[]; imported: SshHost[]; client: string | null }
export interface SearchMatch { path: string; line: number; column: number; preview: string }
export interface SearchResult { matches: SearchMatch[]; files: number; truncated: boolean }
export interface SearchOptions { regex: boolean; caseSensitive: boolean; wholeWord: boolean }
export interface Branches { current: string | null; local: string[]; remote: string[] }
export interface Commit { hash: string; subject: string; author: string; when: string }
export interface PlanItem { action: 'remove' | 'keep' | 'package' | 'rescue' | 'nothing' | 'skip'; detail: string }
export interface AppPaths { config: string; directories: string[]; home: string; version: string; platform: string }
export interface ShellOption { name: string; path: string }
export interface Change { path: string; index: string; worktree: string; original?: string | null }
export interface GitStatus { branch: string | null; changes: Change[] }
export interface Diff { before: string; after: string }
export interface Dependency { name: string; version: string }
export interface PackageMatch extends Dependency { summary: string | null }
export interface Packages { manifests: string[]; installed: Dependency[]; environment: string | null; warning: string | null }
export interface Diagnostic { path: string; line: number; column: number; severity: 'error' | 'warning'; message: string }
export interface JobEvent {
  id: string
  kind: 'command' | 'stdout' | 'stderr' | 'exit'
  text: string
  code: number | null
  diagnostics: Diagnostic[]
}

export const desktop = isTauri()
export const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
export const fileName = (path: string) => path.split('/').at(-1) || path
export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
export const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
/** A short fingerprint of a text (FNV-1a), to notice when a file changed. */
export function textHash(text: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(16) + ':' + text.length
}

/** Unsaved edits kept outside the project, so closing Still or a crash loses nothing. */
export interface BackupEntry { path: string; contents: string; base: string; time: number }
export const backups = {
  write: (key: string, entries: BackupEntry[]) => desktop ? invoke<void>('backup_write', { key, entries: JSON.stringify(entries) }) : Promise.resolve(),
  read: async (key: string): Promise<BackupEntry[]> => {
    if (!desktop) return []
    try { const list = JSON.parse(await invoke<string>('backup_read', { key })); return Array.isArray(list) ? list.filter(item => item && typeof item.path === 'string' && typeof item.contents === 'string') : [] } catch { return [] }
  },
}

/** The folder or file Still was started with (`still .`, Open with Still), once. */
export const launcher = {
  target: () => desktop ? invoke<{ path: string; directory: boolean } | null>('launch_target').catch(() => null) : Promise.resolve(null),
  installCli: () => invoke<string>('install_cli'),
  explorerMenu: (enable: boolean) => invoke<string>('explorer_menu', { enable }),
  shellIntegration: (enable: boolean) => invoke<string>('shell_integration', { enable }),
  writeText: (path: string, contents: string) => invoke<void>('write_text_file', { path, contents }),
  readText: (path: string) => invoke<string>('read_text_file', { path }),
}
export const demo: Workspace = { root: 'orbit-lab', name: 'Orbit Lab', sample: true }

/** Forgets what Still remembered for a project folder (breakpoints, watches, run settings, open
 *  files, canvas layout), so a new project created in the same place starts clean. */
export async function forgetProject(root: string): Promise<void> {
  const prefixes = ['still.breakpoints.', 'still.breakpointOptions.', 'still.watches.', 'still.runconfig.', 'still.session.', 'still.canvas.', 'still.container.use.', 'still.container.seen.', 'still.db.']
  try {
    for (const prefix of prefixes) localStorage.removeItem(prefix + root)
    for (const key of Object.keys(localStorage)) if (key.startsWith('still.db.sql.' + root + '.')) localStorage.removeItem(key)
  } catch { /* storage unavailable */ }
  // Unsaved edits kept for an old project in the same place mustn't come back into the new one.
  await backups.write('|' + root, []).catch(() => {})
}
const demoContents: Record<string, string> = {
  'src/app.py': appSource, 'src/Main.java': javaSource, 'tests/test_orbit.py': orbitTest,
  '.gitignore': gitignore, 'README.md': readme, 'requirements.txt': requirements,
}
const key = 'still.preview.files'
const disk = (): Record<string, string> => ({ ...demoContents, ...JSON.parse(localStorage.getItem(key) ?? '{}') })
const baseline = new Map(Object.entries({ ...demoContents,
  'src/app.py': appSource.replace('Calculate the orbital period of a body around Earth.', 'Calculate orbital periods around Earth.'),
}))
baseline.delete('tests/test_orbit.py')
const staged = new Map<string, string>()
const previewPackages: PackageMatch[] = [
  { name: 'numpy', version: '2.x', summary: 'Arrays and numerical computing.' },
  { name: 'requests', version: '2.x', summary: 'An HTTP client for Python.' },
  { name: 'pytest', version: '9.x', summary: 'A framework for Python tests.' },
  { name: 'ruff', version: '0.x', summary: 'A Python linter and formatter.' },
]

function demoTree(path: string): Entry[] {
  const prefix = path ? path + '/' : ''
  const entries = new Map<string, Entry>()
  for (const file of Object.keys(disk())) {
    if (!file.startsWith(prefix)) continue
    const [name, child] = file.slice(prefix.length).split('/')
    entries.set(name, { name, path: prefix + name, directory: child !== undefined })
  }
  return [...entries.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
}

function demoGit(): GitStatus {
  const files = disk()
  const changes: Change[] = []
  for (const [path, content] of Object.entries(files)) {
    if (staged.has(path)) {
      const index = !baseline.has(path) ? 'A' : baseline.get(path) === staged.get(path) ? ' ' : 'M'
      const worktree = staged.get(path) === content ? ' ' : 'M'
      if (index !== ' ' || worktree !== ' ') changes.push({ path, index, worktree })
    } else if (!baseline.has(path)) {
      changes.push({ path, index: '?', worktree: '?' })
    } else if (content !== baseline.get(path)) {
      changes.push({ path, index: ' ', worktree: 'M' })
    }
  }
  return { branch: 'main', changes }
}

export async function pickFolder(title: string): Promise<string | null> {
  if (!desktop) throw new Error('Choosing folders is available in the Still desktop app.')
  const path = await open({ directory: true, multiple: false, title })
  return !path || Array.isArray(path) ? null : path
}

const demoHome = (): HomeState => ({
  projectsRoot: '~/Projects', suggestedRoot: '~/Projects',
  projects: [{
    name: 'Orbit Lab', path: 'orbit-lab', location: 'library', lastOpened: Date.now() - 36e5, modified: Date.now() - 864e5,
    languages: ['Python', 'Java'], branch: 'main', description: readme.split('\n').find(line => line && !line.startsWith('#')) ?? null, pinned: false, missing: false,
  }],
})

export const home = {
  state: async (): Promise<HomeState> => desktop ? invoke('home_state') : demoHome(),
  setRoot: (path: string) => invoke<string>('set_projects_root', { path }),
  open: async (path: string): Promise<Workspace> => desktop ? invoke('open_project', { path }) : demo,
  forget: (path: string) => invoke<void>('forget_project', { path }),
  /** Moves the project folder to the system trash and takes it off Home. */
  remove: (path: string) => invoke<void>('delete_project', { path }),
  pin: (path: string, pinned: boolean) => invoke<void>('pin_project', { path, pinned }),
  create: (name: string, templateKind: string, parent: string | null, git: boolean, readme = true, requirements = true) => invoke<Workspace>('create_project', { name, templateKind, parent, git, readme, requirements }),
  clone: (id: string, url: string, name: string | null, parent: string | null) => invoke<string>('clone_project', { id, url, name, parent }),
  reveal: (path: string) => invoke<void>('reveal_path', { path }),
  paths: () => invoke<AppPaths>('app_paths'),
  shells: async (): Promise<ShellOption[]> => desktop ? invoke('detect_shells') : [],
  uninstallPlan: () => invoke<PlanItem[]>('uninstall_plan'),
  uninstall: (confirm: string) => invoke<void>('uninstall_start', { confirm }),
}

// ---- Passwords for remote files ------------------------------------------------
// When a server needs a password, the app shows one prompt (registered by App),
// sends the answer to the backend's in-memory store and retries the call.
type PasswordPrompt = (host: string, retry: boolean) => Promise<string | null>
let prompt: PasswordPrompt | null = null
const pending = new Map<string, Promise<boolean>>()
const hostNames = new Map<string, string>()
export function setPasswordPrompt(value: PasswordPrompt | null) { prompt = value }
export function nameHost(id: string, name: string) { hostNames.set(id, name) }

async function askFor(id: string, retry: boolean): Promise<boolean> {
  const running = pending.get(id)
  if (running) return running
  const task = (async () => {
    const answer = prompt ? await prompt(hostNames.get(id) ?? id, retry) : null
    if (answer === null) return false
    await invoke('ssh_set_password', { id, password: answer })
    return true
  })().finally(() => pending.delete(id))
  pending.set(id, task)
  return task
}

/** Runs an SSH call; if the server wants a password, asks for it (up to three tries) and runs it again. */
export async function withPassword<T>(id: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call() } catch (error) {
      const message = String(error)
      if (!message.startsWith('PASSWORD:') || attempt >= 3) throw message.replace(/^PASSWORD:\s*/, '')
      if (!await askFor(id, attempt > 0 || message.includes("didn't work"))) throw 'This server needs a password to open files.'
    }
  }
}

export interface RemoteListing { path: string; home: string; entries: Entry[] }
export interface ForwardedPort { id: string; hostId: string; hostName: string; remotePort: number; localPort: number }
export interface ListeningPort { port: number; process: string }

export const ssh = {
  hosts: async (): Promise<SshOverview> => desktop ? invoke('ssh_hosts') : { saved: [], imported: [], client: null },
  save: (host: SshHost) => invoke<SshHost>('ssh_save_host', { host }),
  remove: (id: string) => invoke<void>('ssh_delete_host', { id }),
  test: (id: string) => withPassword(id, () => invoke<string>('ssh_test', { id })),
  /** Forwards a port on the server to localhost here; the local port is the same when it's free. */
  forward: (hostId: string, remotePort: number, localPort?: number) => withPassword(hostId, () => invoke<ForwardedPort>('ssh_forward_start', { hostId, remotePort, localPort: localPort ?? null })),
  unforward: (id: string) => invoke<void>('ssh_forward_stop', { id }),
  forwards: () => desktop ? invoke<ForwardedPort[]>('ssh_forward_list') : Promise.resolve([] as ForwardedPort[]),
  listening: (id: string) => withPassword(id, () => invoke<ListeningPort[]>('ssh_listening_ports', { id })),
  resolve: (id: string, path: string) => withPassword(id, () => invoke<string>('ssh_resolve', { id, path })),
  browse: (id: string, path: string) => withPassword(id, () => invoke<RemoteListing>('ssh_browse', { id, path })),
}

export const hostLabel = (host: SshHost) => (host.user ? host.user + '@' : '') + (host.address || host.host) + (host.port && host.port !== 22 ? ':' + host.port : '')

/** File operations for a workspace, whether local, remote over SSH, or the browser preview. */
export interface FileSystem {
  list: (path?: string) => Promise<Entry[]>
  files: () => Promise<Entry[]>
  read: (path: string) => Promise<string>
  /** A binary file (PDF, image) as base64. */
  readBinary: (path: string) => Promise<string>
  save: (path: string, contents: string, previous: string) => Promise<void>
  create: (path: string) => Promise<void>
  createFolder: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  search: (query: string, options: SearchOptions) => Promise<SearchResult>
}

export function fileSystem(workspace: Workspace): FileSystem {
  const rootPath = workspace.root
  if (workspace.remote) {
    const id = workspace.remote
    const root = workspace.root
    if (workspace.hostName) nameHost(id, workspace.hostName)
    const call = <T>(command: string, args: object) => withPassword(id, () => invoke<T>(command, { id, root, ...args }))
    return {
      list: (path = '') => call('ssh_list', { path }),
      files: () => call('ssh_files', {}),
      read: async path => normalize(await call<string>('ssh_read', { path })),
      readBinary: path => call<string>('ssh_read_binary', { path }),
      save: (path, contents) => call('ssh_write', { path, contents }),
      create: path => call('ssh_fs', { op: 'touch', path, target: null }),
      createFolder: path => call('ssh_fs', { op: 'mkdir', path, target: null }),
      rename: (from, to) => call('ssh_fs', { op: 'rename', path: from, target: to }),
      remove: path => call('ssh_fs', { op: 'delete', path, target: null }),
      search: (query, options) => call('ssh_search', { query, ...options }),
    }
  }
  if (desktop) return {
    list: (path = '') => invoke('list_directory', { rootPath, path }),
    files: () => invoke('list_files', { rootPath }),
    read: async path => normalize(await invoke<string>('read_file', { rootPath, path })),
    readBinary: path => invoke<string>('read_binary', { rootPath, path }),
    save: (path, contents, previous) => invoke('save_file', { rootPath, path, contents, previous }),
    create: path => invoke('create_file', { rootPath, path }),
    createFolder: path => invoke('create_folder', { rootPath, path }),
    rename: (from, to) => invoke('rename_path', { rootPath, from, to }),
    remove: path => invoke('delete_path', { rootPath, path }),
    search: (query, options) => invoke('search_workspace', { rootPath, query, ...options }),
  }
  const write = (files: Record<string, string>) => localStorage.setItem(key, JSON.stringify(files))
  return {
    list: async (path = '') => demoTree(path),
    files: async () => Object.keys(disk()).map(path => ({ path, name: fileName(path), directory: false })),
    read: async path => normalize(disk()[path] ?? ''),
    readBinary: async () => { throw new Error('PDFs and images open in the Still desktop app.') },
    save: async (path, contents) => write({ ...disk(), [path]: contents }),
    create: async path => api.create(rootPath, path),
    createFolder: async () => { throw new Error('Folders are available in the Still desktop app.') },
    rename: async (from, to) => {
      const files = disk()
      if (!(from in files)) throw new Error('Renaming folders is available in the Still desktop app.')
      if (to in files) throw new Error('A file already exists at this path.')
      files[to] = files[from]
      delete files[from]
      write(files)
    },
    remove: async path => { const files = disk(); delete files[path]; write(files) },
    search: async (query, options) => {
      const matches: SearchMatch[] = []
      let pattern: RegExp
      try {
        const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        pattern = new RegExp(options.wholeWord ? '\\b(?:' + source + ')\\b' : source, options.caseSensitive ? '' : 'i')
      } catch { throw new Error('This regular expression is not valid.') }
      for (const [path, text] of Object.entries(disk())) {
        text.split('\n').forEach((line, index) => {
          const found = pattern.exec(line)
          if (found) matches.push({ path, line: index + 1, column: found.index + 1, preview: line.trimEnd().slice(0, 240) })
        })
      }
      return { matches, files: new Set(matches.map(item => item.path)).size, truncated: false }
    },
  }
}

export const api = {
  list: async (rootPath: string, path = '') => desktop
    ? invoke<Entry[]>('list_directory', { rootPath, path }) : demoTree(path),
  files: async (rootPath: string) => desktop ? invoke<Entry[]>('list_files', { rootPath })
    : Object.keys(disk()).map(path => ({ path, name: fileName(path), directory: false })),
  read: async (rootPath: string, path: string) => normalize(desktop
    ? await invoke<string>('read_file', { rootPath, path }) : disk()[path] ?? ''),
  save: async (rootPath: string, path: string, contents: string, previous: string) => {
    if (desktop) return invoke<void>('save_file', { rootPath, path, contents, previous })
    localStorage.setItem(key, JSON.stringify({ ...disk(), [path]: contents }))
  },
  create: async (rootPath: string, path: string) => {
    if (desktop) return invoke<void>('create_file', { rootPath, path })
    const parts = path.split('/')
    if (parts.some(part => !part || part === '..' || part === '.' || part.includes('\\'))) throw new Error('Enter a workspace-relative file path.')
    if (path in disk()) throw new Error('A file already exists at this path.')
    if (parts.length > 1 && !Object.keys(disk()).some(file => file.startsWith(parentPath(path) + '/'))) throw new Error('This folder does not exist.')
    localStorage.setItem(key, JSON.stringify({ ...disk(), [path]: '' }))
  },
  runtimes: async (rootPath: string): Promise<Runtimes> => desktop
    ? invoke('detect_runtimes', { rootPath }) : { python: null, pythonVenv: false, java: null, shell: 'Shell' },
  branches: (rootPath: string) => invoke<Branches>('git_branches', { rootPath }),
  checkout: (rootPath: string, branch: string, create: boolean) => invoke<void>('git_checkout', { rootPath, branch, create }),
  stash: (rootPath: string, action: 'push' | 'pop' | 'apply' | 'drop' | 'list', index?: number, message?: string) => invoke<{ index: number; message: string; when: string }[]>('git_stash', { rootPath, action, index: index ?? null, message: message ?? null }),
  applyPatch: (rootPath: string, patch: string, cached: boolean, reverse = false) => invoke<void>('git_apply_patch', { rootPath, patch, cached, reverse }),
  remoteUrl: (rootPath: string) => invoke<string>('git_remote_url', { rootPath }),
  checkoutPr: (rootPath: string, number: number) => invoke<string>('git_checkout_pr', { rootPath, number }),
  stageAll: async (rootPath: string, unstage: boolean) => {
    if (desktop) return invoke<void>('git_stage_all', { rootPath, unstage })
    if (unstage) staged.clear()
    else for (const change of demoGit().changes) staged.set(change.path, disk()[change.path])
  },
  discard: (rootPath: string, change: Change) => invoke<void>('git_discard', { rootPath, path: change.path, untracked: change.worktree === '?' }),
  log: async (rootPath: string): Promise<Commit[]> => desktop ? invoke('git_log', { rootPath })
    : [{ hash: 'a1b2c3d', subject: 'Add orbital period examples', author: 'Still', when: '2 days ago' }],
  gitInit: (rootPath: string) => invoke<void>('git_init', { rootPath }),
  git: async (rootPath: string): Promise<GitStatus> => desktop ? invoke('git_status', { rootPath }) : demoGit(),
  diff: async (rootPath: string, change: Change, index: boolean): Promise<Diff> => desktop
    ? invoke('git_diff', { rootPath, path: change.path, original: change.original ?? null, staged: index })
    : { before: (index ? baseline.get(change.path) : staged.get(change.path) ?? baseline.get(change.path)) ?? '',
        after: (index ? staged.get(change.path) : disk()[change.path]) ?? '' },
  stage: async (rootPath: string, change: Change, unstaged: boolean) => {
    if (desktop) return invoke<void>('git_stage', { rootPath, path: change.path, original: change.original ?? null, unstaged })
    if (unstaged) staged.delete(change.path)
    else staged.set(change.path, disk()[change.path])
  },
  previewCommit: () => {
    for (const [path, value] of staged) baseline.set(path, value)
    staged.clear()
  },
  packages: async (rootPath: string): Promise<Packages> => desktop ? invoke('package_state', { rootPath })
    : { manifests: ['requirements.txt'], installed: [], environment: null, warning: null },
  search: async (name: string): Promise<PackageMatch[]> => {
    if (!desktop) return previewPackages.filter(item => item.name.includes(name.toLowerCase()))
    const result = await invoke<PackageMatch | null>('package_search', { name })
    return result ? [result] : []
  },
}

// ---- Clipboard ------------------------------------------------------------------
// The web view's own clipboard API may ask for permission (or refuse) when reading,
// so the desktop app goes through Tauri's clipboard plugin.
export const clipboard = {
  read: async (): Promise<string> => {
    if (desktop) { const { readText } = await import('@tauri-apps/plugin-clipboard-manager'); return (await readText()) ?? '' }
    return navigator.clipboard.readText()
  },
  write: async (text: string) => {
    if (desktop) { const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); await writeText(text); return }
    await navigator.clipboard.writeText(text)
  },
}

export const editorSupport = {
  head: async (rootPath: string, path: string): Promise<string | null> => desktop ? invoke('git_head_text', { rootPath, path }) : null,
  checkPython: (rootPath: string, source: string, path?: string, lint = true) => invoke<{ line: number; column: number; endLine?: number | null; endColumn?: number | null; severity: 'error' | 'warning'; message: string }[]>('check_python', { rootPath, source, path: path ?? null, lint }),
  format: (rootPath: string, path: string, source: string, options?: Record<string, unknown>) => invoke<{ text: string | null; tool: string | null; hint: string | null }>('format_code', { rootPath, path, source, options: options ?? null }),
  tools: (rootPath: string | null) => invoke<{ name: string; purpose: string; found: string | null; install: string | null }[]>('tools_status', { rootPath }),
  install: (rootPath: string | null, id: string, tool: string) => invoke<void>('install_tool', { rootPath, id, tool }),
}

/** Starting contents for a new file, from its name: a Java class with its package, a pytest file, an HTML page… */
export function fileTemplate(path: string): string {
  const name = path.split('/').at(-1) ?? path
  const base = name.replace(/\.[^.]+$/, '')
  const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
  if (extension === 'java') {
    const folders = path.split('/').slice(0, -1)
    const start = folders.findIndex(part => part === 'java' || part === 'src')
    const pkg = (start >= 0 ? folders.slice(start + 1) : []).filter(part => /^[a-z_][\w]*$/.test(part)).join('.')
    const kind = /Test$/.test(base) ? 'test' : 'class'
    const body = kind === 'test'
      ? `import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\n\nclass ${base} {\n    @Test\n    void works() {\n        assertTrue(true);\n    }\n}\n`
      : `public class ${base} {\n\n}\n`
    return (pkg ? `package ${pkg};\n\n` : '') + body
  }
  if (extension === 'py' && /^test_|_test\.py$/.test(name)) return 'def test_example():\n    assert 1 + 1 == 2\n'
  if (extension === 'py' && name === '__main__.py') return 'def main() -> None:\n    pass\n\n\nif __name__ == "__main__":\n    main()\n'
  if (extension === 'html') return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${base}</title>\n</head>\n<body>\n\n</body>\n</html>\n`
  if (extension === 'sh') return '#!/usr/bin/env bash\nset -euo pipefail\n\n'
  if (extension === 'md') return `# ${base.replace(/[-_]/g, ' ')}\n\n`
  if (/^(test|spec)/.test(base) && ['js', 'ts'].includes(extension)) return `import { test } from 'node:test'\nimport assert from 'node:assert'\n\ntest('works', () => {\n  assert.equal(1 + 1, 2)\n})\n`
  return ''
}

export interface BlameLine { line: number; hash: string; author: string; time: number; summary: string }
export interface FileCommit { hash: string; subject: string; author: string; time: number; path: string }
export interface TexResult { pdf: string | null; engine: string | null; seconds: number; errors: { line: number; message: string }[]; log: string }
export const tex = {
  compile: (rootPath: string, path: string) => invoke<TexResult>('tex_compile', { rootPath, path }),
}

export const history = {
  save: (rootPath: string, path: string, contents: string) => desktop ? invoke<void>('history_save', { rootPath, path, contents }) : Promise.resolve(),
  list: async (rootPath: string, path: string): Promise<{ id: string; time: number; size: number }[]> => desktop ? invoke('history_list', { rootPath, path }) : [],
  read: (rootPath: string, path: string, id: string) => invoke<string>('history_read', { rootPath, path, id }),
  blame: async (rootPath: string, path: string, contents?: string): Promise<BlameLine[]> => desktop ? invoke('git_blame', { rootPath, path, contents: contents ?? null }) : [],
  fileLog: async (rootPath: string, path: string): Promise<FileCommit[]> => desktop ? invoke('git_file_log', { rootPath, path }) : [],
  showAt: (rootPath: string, rev: string, path: string) => invoke<string>('git_show_at', { rootPath, rev, path }),
  graph: (rootPath: string, limit?: number) => invoke<import('./GitGraph').GraphCommit[]>('git_graph', { rootPath, limit: limit ?? null }),
  commitDetail: (rootPath: string, hash: string) => invoke<{ message: string; author: string; date: string; parent: string | null; files: { path: string; oldPath: string | null; status: string; additions: number | null; deletions: number | null }[] }>('git_commit_detail', { rootPath, hash }),
}

/** A project's dev container (.devcontainer/devcontainer.json): what it is and whether it's running. */
export interface ContainerInfo { config: string; name: string; docker: boolean; state: 'none' | 'stopped' | 'running'; id: string | null; workspace: string; image: string | null; note: string | null }
export const containers = {
  status: (rootPath: string) => invoke<ContainerInfo>('container_status', { rootPath }),
  stop: (rootPath: string, remove = false) => invoke<void>('container_stop', { rootPath, remove }),
}
