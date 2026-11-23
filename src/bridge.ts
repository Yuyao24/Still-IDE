import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import appSource from '../src-tauri/sample/app.py?raw'
import javaSource from '../src-tauri/sample/Main.java?raw'
import readme from '../src-tauri/sample/README.md?raw'
import orbitTest from '../src-tauri/sample/test_orbit.py?raw'
import requirements from '../src-tauri/sample/requirements.txt?raw'
import gitignore from '../src-tauri/sample/gitignore.txt?raw'

export interface Workspace { root: string; name: string; sample: boolean }
export interface Entry { name: string; path: string; directory: boolean }
export interface Runtimes { python: string | null; pythonVenv: boolean; java: string | null; shell: string }
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
const demo: Workspace = { root: 'orbit-lab', name: 'orbit-lab', sample: true }
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

export async function initialWorkspace(): Promise<Workspace> {
  if (!desktop) return demo
  const previous = localStorage.getItem('still.workspace')
  if (previous) {
    try { return await invoke('workspace_info', { path: previous }) } catch { localStorage.removeItem('still.workspace') }
  }
  return invoke('sample_workspace')
}

export async function chooseWorkspace(): Promise<Workspace | null> {
  if (!desktop) throw new Error('Open local folders in the Still desktop app.')
  const path = await open({ directory: true, multiple: false, title: 'Open Workspace' })
  if (!path || Array.isArray(path)) return null
  const workspace = await invoke<Workspace>('workspace_info', { path })
  localStorage.setItem('still.workspace', workspace.root)
  return workspace
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
