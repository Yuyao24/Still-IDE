// Moving or renaming a file (or a folder of them) keeps the code that imports it working:
// Python imports (absolute and relative), JavaScript and TypeScript relative imports, and Java
// packages and imports are rewritten to the new place. Nothing is written here: this works out
// the new text of each affected file, and the caller asks first and then applies it.

export interface ImportUpdate { /** The file's path after the move. */ path: string; before: string; after: string }

const pythonFile = /\.py$/
const scriptFile = /\.(m?[jt]sx?|c[jt]s|vue|svelte)$/
const javaFile = /\.java$/

const dirOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function normalize(path: string): string | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!out.length) return null; out.pop() } else out.push(part)
  }
  return out.join('/')
}

function relativePath(fromDir: string, to: string) {
  const a = fromDir ? fromDir.split('/') : [], b = to.split('/')
  let common = 0
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++
  const up = a.length - common
  const rest = b.slice(common).join('/')
  return (up ? '../'.repeat(up) : './') + rest
}

/** Where each moved file ends up. */
function moveMap(files: string[], from: string, to: string, directory: boolean) {
  const moves = new Map<string, string>()
  for (const file of files) {
    if (file === from) moves.set(file, to)
    else if (directory && file.startsWith(from + '/')) moves.set(file, to + file.slice(from.length))
  }
  return moves
}

/** Works out how every file that imports the moved file(s) changes. `read` gives a file's current text. */
export async function importUpdatesForMove(files: string[], read: (path: string) => Promise<string>, from: string, to: string, directory: boolean): Promise<ImportUpdate[]> {
  const moves = moveMap(files, from, to, directory)
  if (!moves.size || from === to) return []
  const moved = [...moves.keys()]
  const kinds = { python: moved.some(path => pythonFile.test(path)), script: moved.some(path => scriptFile.test(path)), java: moved.some(path => javaFile.test(path)) }
  const candidates = files.filter(path => (kinds.python && pythonFile.test(path)) || (kinds.script && scriptFile.test(path)) || (kinds.java && javaFile.test(path))).slice(0, 4000)
  const texts = new Map<string, string>()
  for (let index = 0; index < candidates.length; index += 24) {
    const batch = candidates.slice(index, index + 24)
    const loaded = await Promise.all(batch.map(path => read(path).then(text => [path, text] as const, () => null)))
    for (const item of loaded) if (item) texts.set(item[0], item[1])
  }
  const fileSet = new Set(files)
  // Folders that hold Python code (and their parents), for telling project modules from others.
  const pyDirs = new Set<string>()
  for (const file of files) if (pythonFile.test(file)) for (let dir = dirOf(file); dir && !pyDirs.has(dir); dir = dirOf(dir)) pyDirs.add(dir)
  const python = { files: fileSet, dirs: pyDirs, roots: files.some(file => file.startsWith('src/') && file.endsWith('.py')) ? ['', 'src'] : [''] }
  const java = kinds.java ? javaPlan(moves, texts) : null
  const updates: ImportUpdate[] = []
  for (const [path, before] of texts) {
    let after = before
    if (pythonFile.test(path) && kinds.python) after = rewritePython(after, path, moves, from, to, directory, python)
    if (scriptFile.test(path) && kinds.script) after = rewriteScript(after, path, moves, fileSet)
    if (javaFile.test(path) && java) after = java(after, path)
    if (after !== before) updates.push({ path: moves.get(path) ?? path, before, after })
  }
  return updates
}

// ---- Python ----
function rewritePython(text: string, path: string, moves: Map<string, string>, from: string, to: string, directory: boolean, project: { files: Set<string>; dirs: Set<string>; roots: string[] }): string {
  const { files, dirs, roots } = project
  const toPath = (module: string, root: string) => (root ? root + '/' : '') + module.split('.').join('/')
  const toModule = (target: string, root: string) => {
    if (root && !target.startsWith(root + '/')) return null
    const rel = root ? target.slice(root.length + 1) : target
    return rel.split('/').every(part => /^[A-Za-z_]\w*$/.test(part)) ? rel.split('/').join('.') : null
  }
  /** A module's path ('pkg/mod', no .py) after the move, or null if it didn't move. */
  const movedModule = (target: string): string | null => {
    const file = moves.get(target + '.py')
    if (file) return file.slice(0, -3)
    const init = moves.get(target + '/__init__.py')
    if (init) return dirOf(init)
    if (directory && (target === from || target.startsWith(from + '/'))) return to + target.slice(from.length)
    return null
  }
  const exists = (target: string) => files.has(target + '.py') || files.has(target + '/__init__.py') || dirs.has(target)
  const newPath = moves.get(path) ?? path
  const packageOf = (file: string) => dirOf(file)
  const usages: [RegExp, string][] = []

  // `from X import a, b` and `from .x import a` (also in brackets over several lines).
  text = text.replace(/^([ \t]*)from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+(\([^)]*\)|(?:[^\n\\#]|\\\n)*)/gm, (whole, indent: string, dots: string, module: string | undefined, names: string) => {
    module ??= ''
    // Resolve to a project path, under each source root for absolute imports.
    const options: { target: string; root: string | null }[] = []
    if (dots) {
      const parts = packageOf(path).split('/').filter(Boolean)
      if (dots.length - 1 > parts.length) return whole
      const base = parts.slice(0, parts.length - (dots.length - 1)).join('/')
      options.push({ target: [base, ...module.split('.').filter(Boolean)].filter(Boolean).join('/'), root: null })
    } else for (const root of roots) options.push({ target: toPath(module, root), root })
    for (const { target, root } of options) {
      if (!dots && !exists(target)) continue
      const express = (destination: string) => {
        if (root !== null) return toModule(destination, root)
        // Relative: from the file's (new) package to the destination.
        const own = packageOf(newPath).split('/').filter(Boolean)
        const goal = destination.split('/').filter(Boolean)
        let common = 0
        while (common < own.length && common < goal.length && own[common] === goal[common]) common++
        return '.'.repeat(own.length - common + 1) + goal.slice(common).join('.')
      }
      const movedTarget = movedModule(target)
      if (movedTarget !== null || (dots && moves.has(path))) {
        const next = express(movedTarget ?? target)
        if (next === null) return whole
        return dots || next !== module ? `${indent}from ${next} import ${names}` : whole
      }
      // `from pkg import mod` where mod is the module that moved.
      const items = names.replace(/^\(|\)$/g, '').split(',').map(item => item.trim()).filter(Boolean)
      const keep: string[] = [], extra: string[] = []
      for (const item of items) {
        const [name, alias] = item.split(/\s+as\s+/)
        const destination = movedModule((target ? target + '/' : '') + name)
        if (destination === null) { keep.push(item); continue }
        const parent = express(dirOf(destination))
        const leaf = baseOf(destination)
        if (parent === null) { keep.push(item); continue }
        if (!alias && leaf !== name) usages.push([new RegExp('(?<![\\w.])' + escape(name) + '(?=\\s*\\.)', 'g'), leaf])
        extra.push(parent && parent !== '' ? `${indent}from ${parent} import ${leaf}${alias ? ' as ' + alias : ''}` : `${indent}import ${leaf}${alias ? ' as ' + alias : ''}`)
      }
      if (!extra.length) return whole
      return [keep.length ? `${indent}from ${dots}${module} import ${keep.join(', ')}` : null, ...extra].filter(Boolean).join('\n')
    }
    return whole
  })
  // `import a.b.c` and `import a.b as c, d`.
  text = text.replace(/^([ \t]*)import[ \t]+([^\n#;]+)/gm, (whole, indent: string, list: string) => {
    let changed = false
    const items = list.split(',').map(item => {
      const match = /^\s*([A-Za-z_][\w.]*)(\s+as\s+\w+)?\s*$/.exec(item)
      if (!match) return item.trim()
      for (const root of roots) {
        const target = toPath(match[1], root)
        if (!exists(target)) continue
        const destination = movedModule(target)
        const next = destination !== null ? toModule(destination, root) : null
        if (next && next !== match[1]) {
          changed = true
          if (!match[2]) usages.push([new RegExp('(?<![\\w.])' + escape(match[1]) + '(?=\\.)', 'g'), next])
          return next + (match[2] ?? '')
        }
      }
      return item.trim()
    })
    return changed ? `${indent}import ${items.join(', ')}` : whole
  })
  for (const [pattern, replacement] of usages) {
    // Rename uses in the code, not in the import lines just written.
    text = text.split('\n').map(line => /^\s*(from|import)\s/.test(line) ? line : line.replace(pattern, replacement)).join('\n')
  }
  return text
}

// ---- JavaScript and TypeScript ----
const scriptExtensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte', '.css', '.scss']
function rewriteScript(text: string, path: string, moves: Map<string, string>, files: Set<string>): string {
  const newPath = moves.get(path) ?? path
  return text.replace(/(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"\n]*)\2/g, (whole, lead: string, quote: string, spec: string) => {
    const base = normalize(dirOf(path) + '/' + spec)
    if (base === null) return whole
    let target: string | null = null, style: 'exact' | 'bare' | 'swap' | 'index' = 'exact', swapped = ''
    if (files.has(base)) target = base
    if (!target) for (const ext of scriptExtensions) if (files.has(base + ext)) { target = base + ext; style = 'bare'; break }
    if (!target) {
      const swap: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
      const ext = /\.[cm]?jsx?$/.exec(base)?.[0]
      for (const option of ext ? swap[ext] ?? [] : []) if (files.has(base.slice(0, -ext!.length) + option)) { target = base.slice(0, -ext!.length) + option; style = 'swap'; swapped = ext!; break }
    }
    if (!target) for (const ext of scriptExtensions) if (files.has(base + '/index' + ext)) { target = base + '/index' + ext; style = 'index'; break }
    if (!target) return whole
    const destination = moves.get(target) ?? target
    if (destination === target && newPath === path) return whole
    let next: string
    if (style === 'index') next = relativePath(dirOf(newPath), dirOf(destination))
    else if (style === 'bare') { const ext = scriptExtensions.find(item => destination.endsWith(item)) ?? ''; next = relativePath(dirOf(newPath), destination.slice(0, destination.length - ext.length)) }
    else if (style === 'swap') next = relativePath(dirOf(newPath), destination.replace(/\.[cm]?tsx?$/, swapped))
    else next = relativePath(dirOf(newPath), destination)
    if (next.endsWith('/') && next.length > 2) next = next.slice(0, -1)
    return next === spec ? whole : lead + quote + next + quote
  })
}

// ---- Java ----
/** For each moved .java file: its package and type name before and after, from its source root. */
function javaPlan(moves: Map<string, string>, texts: Map<string, string>) {
  const types: { oldPackage: string; newPackage: string; oldName: string; newName: string; oldDir: string; newPath: string }[] = []
  for (const [oldPath, newPath] of moves) {
    if (!javaFile.test(oldPath)) continue
    const text = texts.get(oldPath)
    if (text === undefined) continue
    const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? ''
    const oldDir = dirOf(oldPath)
    // The source root is the folder the package path hangs from (src/main/java, src, …).
    const packagePath = declared.split('.').join('/')
    if (declared && !(oldDir === packagePath || oldDir.endsWith('/' + packagePath))) continue
    const root = declared ? oldDir.slice(0, oldDir.length - packagePath.length).replace(/\/$/, '') : oldDir
    const newDir = dirOf(newPath)
    if (root && !(newDir === root || newDir.startsWith(root + '/'))) continue
    const rest = root ? newDir.slice(root.length).replace(/^\//, '') : newDir
    if (rest && !rest.split('/').every(part => /^[A-Za-z_]\w*$/.test(part))) continue
    types.push({ oldPackage: declared, newPackage: rest.split('/').filter(Boolean).join('.'), oldName: baseOf(oldPath).slice(0, -5), newName: baseOf(newPath).slice(0, -5), oldDir, newPath })
  }
  if (!types.length) return null
  const packageOfText = (text: string) => /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? ''
  const addImport = (text: string, line: string) => {
    if (text.includes(line)) return text
    const imports = [...text.matchAll(/^import\s[^\n]*;\s*$/gm)]
    if (imports.length) { const last = imports.at(-1)!; const at = (last.index ?? 0) + last[0].length; return text.slice(0, at) + '\n' + line + text.slice(at) }
    const pkg = /^\s*package\s+[\w.]+\s*;[^\n]*\n/m.exec(text)
    if (pkg) { const at = (pkg.index ?? 0) + pkg[0].length; return text.slice(0, at) + '\n' + line + '\n' + text.slice(at) }
    return line + '\n\n' + text
  }
  return (text: string, path: string) => {
    const filePackage = packageOfText(text)
    const selfType = types.find(type => moves.get(path) === type.newPath)
    for (const type of types) {
      const oldFull = (type.oldPackage ? type.oldPackage + '.' : '') + type.oldName
      const newFull = (type.newPackage ? type.newPackage + '.' : '') + type.newName
      if (type === selfType) {
        // The moved file: its package line, its own name, and imports for what it used from its old package.
        if (type.oldPackage !== type.newPackage) {
          text = type.oldPackage ? text.replace(/^(\s*)package\s+[\w.]+\s*;/m, type.newPackage ? `$1package ${type.newPackage};` : '') : `package ${type.newPackage};\n\n` + text
          if (type.oldPackage) {
            const neighbours = [...texts.keys()].filter(other => javaFile.test(other) && dirOf(other) === type.oldDir && other !== path && !moves.has(other)).map(other => baseOf(other).slice(0, -5))
            for (const name of neighbours) if (new RegExp('\\b' + escape(name) + '\\b').test(text.replace(/^\s*(package|import)\s[^\n]*$/gm, ''))) text = addImport(text, `import ${type.oldPackage}.${name};`)
          }
        }
        if (type.oldName !== type.newName) text = text.replace(new RegExp('\\b' + escape(type.oldName) + '\\b', 'g'), type.newName)
        continue
      }
      const before = text
      if (type.oldPackage) {
        text = text.replace(new RegExp('\\b' + escape(oldFull) + '\\b', 'g'), newFull)
        // A whole package that moved: its wildcard imports follow it.
        const everything = [...texts.keys()].filter(other => javaFile.test(other) && dirOf(other) === type.oldDir).every(other => moves.has(other))
        if (everything && type.newPackage) text = text.replace(new RegExp('^(\\s*import\\s+)' + escape(type.oldPackage) + '\\.\\*\\s*;', 'gm'), `$1${type.newPackage}.*;`)
      }
      const imported = before !== text
      const samePackage = filePackage === type.oldPackage
      const uses = new RegExp('\\b' + escape(type.oldName) + '\\b').test(text.replace(/^\s*(package|import)\s[^\n]*$/gm, ''))
      if (type.oldName !== type.newName && (imported || samePackage) && uses) text = text.replace(new RegExp('(?<![\\w.])' + escape(type.oldName) + '\\b', 'g'), type.newName)
      if (samePackage && !imported && uses && type.oldPackage !== type.newPackage && filePackage !== type.newPackage) text = addImport(text, `import ${newFull};`)
      // An import of a class now in this file's own package isn't needed.
      if (filePackage === type.newPackage) text = text.replace(new RegExp('^import\\s+' + escape(newFull) + '\\s*;[ \\t]*\\n', 'm'), '')
    }
    return text
  }
}
