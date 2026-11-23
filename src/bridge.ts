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
export const demo: Workspace = { root: 'orbit-lab', name: 'Orbit Lab', sample: true }
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
  pin: (path: string, pinned: boolean) => invoke<void>('pin_project', { path, pinned }),
  create: (name: string, templateKind: string, parent: string | null, git: boolean) => invoke<Workspace>('create_project', { name, templateKind, parent, git }),
  clone: (id: string, url: string, name: string | null, parent: string | null) => invoke<string>('clone_project', { id, url, name, parent }),
  reveal: (path: string) => invoke<void>('reveal_path', { path }),
  paths: () => invoke<AppPaths>('app_paths'),
  shells: async (): Promise<ShellOption[]> => desktop ? invoke('detect_shells') : [],
  uninstallPlan: () => invoke<PlanItem[]>('uninstall_plan'),
  uninstall: (confirm: string) => invoke<void>('uninstall_start', { confirm }),
}

export const ssh = {
  hosts: async (): Promise<SshOverview> => desktop ? invoke('ssh_hosts') : { saved: [], imported: [], client: null },
  save: (host: SshHost) => invoke<SshHost>('ssh_save_host', { host }),
  remove: (id: string) => invoke<void>('ssh_delete_host', { id }),
  test: (id: string) => invoke<string>('ssh_test', { id }),
  resolve: (id: string, path: string) => invoke<string>('ssh_resolve', { id, path }),
}

export const hostLabel = (host: SshHost) => (host.user ? host.user + '@' : '') + (host.address || host.host) + (host.port && host.port !== 22 ? ':' + host.port : '')

/** File operations for a workspace, whether local, remote over SSH, or the browser preview. */
export interface FileSystem {
  list: (path?: string) => Promise<Entry[]>
  files: () => Promise<Entry[]>
  read: (path: string) => Promise<string>
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
    return {
      list: (path = '') => invoke('ssh_list', { id, root, path }),
      files: () => invoke('ssh_files', { id, root }),
      read: async path => normalize(await invoke<string>('ssh_read', { id, root, path })),
      save: (path, contents) => invoke('ssh_write', { id, root, path, contents }),
      create: path => invoke('ssh_fs', { id, root, op: 'touch', path, target: null }),
      createFolder: path => invoke('ssh_fs', { id, root, op: 'mkdir', path, target: null }),
      rename: (from, to) => invoke('ssh_fs', { id, root, op: 'rename', path: from, target: to }),
      remove: path => invoke('ssh_fs', { id, root, op: 'delete', path, target: null }),
      search: (query, options) => invoke('ssh_search', { id, root, query, ...options }),
    }
  }
  if (desktop) return {
    list: (path = '') => invoke('list_directory', { rootPath, path }),
    files: () => invoke('list_files', { rootPath }),
    read: async path => normalize(await invoke<string>('read_file', { rootPath, path })),
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
