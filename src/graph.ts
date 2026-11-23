// Builds a graph of how project files reference each other (imports and Markdown links)
// and lays it out with a small force simulation. Everything runs locally in the web view.

import type { Entry } from './bridge'

export type NodeGroup = 'source' | 'test' | 'doc' | 'data' | 'package'
export interface GraphNode { id: string; name: string; group: NodeGroup; folder: string; lines: number; degree: number; preview?: string[] }
export interface GraphEdge { from: string; to: string }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }

const sourceExtensions = new Set(['py', 'java', 'kt', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'go', 'rs', 'md', 'markdown', 'mdx'])
const dataExtensions = new Set(['csv', 'json', 'txt', 'tsv', 'yaml', 'yml', 'toml'])
const skipped = /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__|dist|build|target|out|\.next|\.idea|\.vscode)\//
const pythonStandard = new Set(('__future__ abc argparse array ast asyncio base64 bisect builtins calendar collections contextlib copy csv dataclasses datetime decimal ' +
  'difflib enum fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io itertools json logging math multiprocessing ' +
  'operator os pathlib pickle platform pprint queue random re secrets shlex shutil signal socket sqlite3 statistics string struct subprocess sys tempfile ' +
  'textwrap threading time timeit tkinter traceback types typing unittest urllib uuid warnings weakref xml zipfile zoneinfo').split(' '))

const extension = (path: string) => path.split('.').at(-1)?.toLowerCase() ?? ''
const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const baseName = (path: string) => path.split('/').at(-1) ?? path

function groupOf(path: string): NodeGroup {
  const name = baseName(path).toLowerCase()
  const ext = extension(path)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'doc'
  if (dataExtensions.has(ext)) return 'data'
  if (/(^|\/)(tests?|__tests__|spec)\//.test(path) || /^test_|_test\.|\.test\.|\.spec\.|test\.java$|tests?\.py$|^conftest\.py$/.test(name)) return 'test'
  return 'source'
}

/** Joins a relative reference onto a folder, resolving . and .. */
function join(folder: string, reference: string) {
  const parts = folder ? folder.split('/') : []
  for (const part of reference.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

interface Index { paths: Set<string>; bySuffix: Map<string, string[]> }

function index(paths: string[]): Index {
  const bySuffix = new Map<string, string[]>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let start = 0; start < parts.length; start++) {
      const suffix = parts.slice(start).join('/')
      const list = bySuffix.get(suffix)
      if (list) list.push(path)
      else bySuffix.set(suffix, [path])
    }
  }
  return { paths: new Set(paths), bySuffix }
}

/** The closest file ending with `suffix`, preferring ones near `from`. */
function nearest(found: Index, suffix: string, from: string) {
  const options = found.bySuffix.get(suffix)
  if (!options?.length) return null
  if (options.length === 1) return options[0]
  const here = folderOf(from)
  return [...options].sort((a, b) => shared(b, here) - shared(a, here) || a.length - b.length)[0]
}
function shared(path: string, folder: string) {
  const a = path.split('/'), b = folder.split('/')
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count++
  return count
}

type Reference = { file?: string; package?: string }

function python(path: string, text: string, found: Index): Reference[] {
  const out: Reference[] = []
  const folder = folderOf(path)
  const resolve = (module: string, names: string[] = []): Reference[] => {
    const dots = module.match(/^\.*/)![0].length
    const rest = module.slice(dots)
    if (dots) {
      let base = folder
      for (let level = 1; level < dots; level++) base = folderOf(base)
      const target = join(base, rest.replace(/\./g, '/'))
      const hits: Reference[] = []
      for (const candidate of [target + '.py', target + '/__init__.py']) if (found.paths.has(candidate)) { hits.push({ file: candidate }); break }
      // from . import models
      for (const name of names) {
        const file = join(target, name) + '.py'
        if (found.paths.has(file)) hits.push({ file })
      }
      return hits
    }
    const asPath = rest.replace(/\./g, '/')
    const file = nearest(found, asPath + '.py', path) ?? nearest(found, asPath + '/__init__.py', path)
    if (file) return [{ file }]
    const top = rest.split('.')[0]
    return top && !pythonStandard.has(top) ? [{ package: top }] : []
  }
  for (const match of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^\n)#]*)/gm)) {
    out.push(...resolve(match[1], match[2].split(',').map(name => name.trim().split(/\s+/)[0]).filter(Boolean)))
  }
  for (const match of text.matchAll(/^\s*import\s+([\w., ]+)/gm)) {
    for (const module of match[1].split(',')) { const name = module.trim().split(/\s+/)[0]; if (name) out.push(...resolve(name)) }
  }
  return out
}

function script(path: string, text: string, found: Index): Reference[] {
  const out: Reference[] = []
  const folder = folderOf(path)
  const references = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
  for (const match of references) {
    const reference = match[1] ?? match[2] ?? match[3]
    if (!reference) continue
    if (!reference.startsWith('.')) {
      const name = reference.startsWith('@') ? reference.split('/').slice(0, 2).join('/') : reference.split('/')[0]
      if (!name.startsWith('node:')) out.push({ package: name.replace(/\?.*$/, '') })
      continue
    }
    const target = join(folder, reference.replace(/\?.*$/, ''))
    const candidates = [target, ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].map(ext => target + '.' + ext), ...['ts', 'tsx', 'js', 'jsx'].map(ext => target + '/index.' + ext)]
    const file = candidates.find(candidate => found.paths.has(candidate))
    if (file) out.push({ file })
  }
  return out
}

function javaLike(path: string, text: string, found: Index, ext: string): Reference[] {
  const out: Reference[] = []
  for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;?/gm)) {
    const parts = match[1].split('.')
    if (['java', 'javax', 'kotlin', 'android', 'jdk', 'sun'].includes(parts[0])) continue
    const wildcard = Boolean(match[2])
    const file = !wildcard && (nearest(found, parts.join('/') + '.' + ext, path) ?? nearest(found, parts.at(-1) + '.' + ext, path))
    if (file) out.push({ file })
    else if (!wildcard && parts.length > 1) out.push({ package: parts.slice(0, 2).join('.') })
  }
  // Classes in the same folder used by name (Java has no import for those).
  const folder = folderOf(path)
  for (const other of found.paths) {
    if (other === path || folderOf(other) !== folder || extension(other) !== ext) continue
    const name = baseName(other).replace(/\.\w+$/, '')
    if (new RegExp('\\b' + name + '\\b').test(text)) out.push({ file: other })
  }
  return out
}

function markdownLinks(path: string, text: string, found: Index): Reference[] {
  const out: Reference[] = []
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>#]+)[^)]*\)/g)) {
    const reference = decodeURIComponent(match[1])
    if (/^[a-z]+:/i.test(reference) || reference.startsWith('/')) continue
    const file = join(folderOf(path), reference)
    if (found.paths.has(file)) out.push({ file })
  }
  return out
}

export function graphable(entries: Entry[]) {
  return entries.filter(entry => !entry.directory && !skipped.test(entry.path) && (sourceExtensions.has(extension(entry.path)) || dataExtensions.has(extension(entry.path))))
}

/** Reads up to `limit` files and returns how they reference each other. */
export async function buildGraph(entries: Entry[], read: (path: string) => Promise<string>, limit = 400): Promise<Graph> {
  const candidates = graphable(entries)
  const truncated = candidates.length > limit
  const files = candidates.slice(0, limit)
  const found = index(files.map(file => file.path))
  const nodes = new Map<string, GraphNode>()
  for (const file of files) nodes.set(file.path, { id: file.path, name: file.name, group: groupOf(file.path), folder: folderOf(file.path), lines: 0, degree: 0 })
  const edges = new Map<string, GraphEdge>()
  const readable = files.filter(file => sourceExtensions.has(extension(file.path)))
  let next = 0
  // A few reads at a time keeps remote folders responsive.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < readable.length) {
      const file = readable[next++]
      let text = ''
      try { text = await read(file.path) } catch { continue }
      if (text.length > 400000) continue
      const all = text.split('\n')
      nodes.get(file.path)!.lines = all.length
      nodes.get(file.path)!.preview = all.slice(0, 10).map(line => line.slice(0, 90))
      const ext = extension(file.path)
      const references = ext === 'py' ? python(file.path, text, found)
        : ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext) ? script(file.path, text, found)
        : ext === 'java' || ext === 'kt' ? javaLike(file.path, text, found, ext)
        : ['md', 'markdown', 'mdx'].includes(ext) ? markdownLinks(file.path, text, found)
        : []
      for (const reference of references) {
        const target = reference.file ?? 'package:' + reference.package
        if (target === file.path) continue
        if (reference.package && !nodes.has(target)) nodes.set(target, { id: target, name: reference.package!, group: 'package', folder: '', lines: 0, degree: 0 })
        edges.set(file.path + '→' + target, { from: file.path, to: target })
      }
      // Data files mentioned by name.
      for (const other of files) {
        if (nodes.get(other.path)?.group === 'data' && text.includes(other.name)) edges.set(file.path + '→' + other.path, { from: file.path, to: other.path })
      }
    }
  }))
  for (const edge of edges.values()) { nodes.get(edge.from)!.degree++; nodes.get(edge.to)!.degree++ }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated }
}

export function neighbours(graph: Graph, id: string) {
  const imports = graph.edges.filter(edge => edge.from === id).map(edge => edge.to)
  const usedBy = graph.edges.filter(edge => edge.to === id).map(edge => edge.from)
  return { imports, usedBy }
}

// ---- Layout -------------------------------------------------------------------

export interface Point { x: number; y: number }

function seeded(text: string) {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return () => {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507)
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
    return ((hash ^= hash >>> 16) >>> 0) / 4294967296
  }
}

/** A deterministic force layout in a 0–1000 square. Folders start near each other so they stay grouped. */
export function layout(nodes: GraphNode[], edges: GraphEdge[], spacing = 1): Map<string, Point> {
  const random = seeded(nodes.map(node => node.id).join('|'))
  const folders = [...new Set(nodes.map(node => node.group === 'package' ? '~packages' : node.folder))]
  const anchor = new Map(folders.map((folder, index) => {
    const angle = (index / Math.max(1, folders.length)) * Math.PI * 2
    return [folder, { x: 500 + Math.cos(angle) * 260, y: 500 + Math.sin(angle) * 260 }]
  }))
  const points = nodes.map(node => {
    const home = anchor.get(node.group === 'package' ? '~packages' : node.folder)!
    return { id: node.id, x: home.x + (random() - .5) * 160, y: home.y + (random() - .5) * 160, vx: 0, vy: 0 }
  })
  const byId = new Map(points.map((point, index) => [point.id, index]))
  const links = edges.map(edge => [byId.get(edge.from)!, byId.get(edge.to)!]).filter(([a, b]) => a !== undefined && b !== undefined)
  const count = points.length
  const ideal = (count > 1 ? 560 / Math.sqrt(count) : 100) * spacing
  for (let step = 0; step < 280; step++) {
    const heat = 1 - step / 280
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const dx = points[a].x - points[b].x, dy = points[a].y - points[b].y
        const distance = Math.max(1, Math.hypot(dx, dy))
        if (distance > ideal * 4) continue
        const push = (ideal * ideal) / distance / distance * 1.2
        points[a].vx += dx / distance * push; points[a].vy += dy / distance * push
        points[b].vx -= dx / distance * push; points[b].vy -= dy / distance * push
      }
    }
    for (const [a, b] of links) {
      const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const pull = (distance - ideal) / distance * .06
      points[a].vx += dx * pull; points[a].vy += dy * pull
      points[b].vx -= dx * pull; points[b].vy -= dy * pull
    }
    for (const point of points) {
      point.vx += (500 - point.x) * .004; point.vy += (500 - point.y) * .004
      const speed = Math.hypot(point.vx, point.vy)
      const cap = 24 * heat + 1
      if (speed > cap) { point.vx *= cap / speed; point.vy *= cap / speed }
      point.x += point.vx; point.y += point.vy
      point.vx *= .55; point.vy *= .55
    }
  }
  // Fit to the square with a margin.
  const xs = points.map(point => point.x), ys = points.map(point => point.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const scale = Math.min(880 / Math.max(1, maxX - minX), 880 / Math.max(1, maxY - minY), 3)
  const offsetX = 500 - (minX + maxX) / 2 * scale, offsetY = 500 - (minY + maxY) / 2 * scale
  return new Map(points.map(point => [point.id, { x: point.x * scale + offsetX, y: point.y * scale + offsetY }]))
}
