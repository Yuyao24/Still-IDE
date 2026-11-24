// Word suggestions that rank like a real IDE: only names that start with what you typed,
// your own names and the most common built-ins first, each with its signature and where
// it comes from ("builtins", "this file", "keyword"). Replaces CodeMirror's fuzzy lists,
// which offer `property` and `PermissionError` when you type "pri".
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'

type Entry = [name: string, signature?: string]
interface Vocabulary { builtins: Entry[]; keywords: string[]; members: Entry[]; types?: Entry[] }

// Ordered by how often people reach for them.
const python: Vocabulary = {
  builtins: [
    ['print', '(values, sep, end, file, flush)'], ['len', '(obj)'], ['range', '(start, stop, step)'], ['str', '(object)'], ['int', '(x, base)'],
    ['list', '(iterable)'], ['dict', '(**kwargs)'], ['input', '(prompt)'], ['open', '(file, mode, encoding)'], ['enumerate', '(iterable, start)'],
    ['float', '(x)'], ['set', '(iterable)'], ['tuple', '(iterable)'], ['sorted', '(iterable, key, reverse)'], ['sum', '(iterable, start)'],
    ['zip', '(*iterables)'], ['min', '(iterable, key, default)'], ['max', '(iterable, key, default)'], ['abs', '(x)'], ['isinstance', '(obj, class_or_tuple)'],
    ['type', '(object)'], ['bool', '(x)'], ['round', '(number, ndigits)'], ['map', '(function, iterable)'], ['filter', '(function, iterable)'],
    ['any', '(iterable)'], ['all', '(iterable)'], ['super', '()'], ['getattr', '(obj, name, default)'], ['setattr', '(obj, name, value)'],
    ['hasattr', '(obj, name)'], ['repr', '(obj)'], ['format', '(value, format_spec)'], ['reversed', '(sequence)'], ['iter', '(iterable)'],
    ['next', '(iterator, default)'], ['divmod', '(a, b)'], ['pow', '(base, exp, mod)'], ['chr', '(i)'], ['ord', '(c)'], ['hex', '(number)'],
    ['bin', '(number)'], ['id', '(obj)'], ['hash', '(obj)'], ['callable', '(obj)'], ['vars', '(object)'], ['dir', '(object)'], ['help', '(object)'],
    ['frozenset', '(iterable)'], ['bytes', '(source, encoding)'], ['bytearray', '(source)'], ['memoryview', '(obj)'], ['complex', '(real, imag)'],
    ['staticmethod', '(function)'], ['classmethod', '(function)'], ['property', '(fget, fset, fdel, doc)'], ['object', '()'], ['slice', '(start, stop, step)'],
    ['globals', '()'], ['locals', '()'], ['exec', '(source)'], ['eval', '(source)'], ['compile', '(source, filename, mode)'], ['exit', '(code)'],
    ['Exception', '(*args)'], ['ValueError', '(*args)'], ['TypeError', '(*args)'], ['KeyError', '(*args)'], ['IndexError', '(*args)'],
    ['RuntimeError', '(*args)'], ['NotImplementedError', '(*args)'], ['AttributeError', '(*args)'], ['ZeroDivisionError', '(*args)'],
    ['FileNotFoundError', '(*args)'], ['StopIteration', '(*args)'], ['ImportError', '(*args)'], ['OSError', '(*args)'], ['PermissionError', '(*args)'],
    ['__name__'], ['__init__', '(self)'], ['__str__', '(self)'], ['__repr__', '(self)'], ['self'],
  ],
  keywords: ['def', 'return', 'if', 'else', 'elif', 'for', 'in', 'while', 'import', 'from', 'class', 'True', 'False', 'None', 'and', 'or', 'not',
    'try', 'except', 'finally', 'with', 'as', 'is', 'lambda', 'yield', 'pass', 'break', 'continue', 'raise', 'global', 'nonlocal', 'assert', 'del',
    'async', 'await', 'match', 'case'],
  members: [
    ['append', '(object)'], ['join', '(iterable)'], ['split', '(sep, maxsplit)'], ['strip', '(chars)'], ['format', '(*args, **kwargs)'], ['items', '()'],
    ['keys', '()'], ['values', '()'], ['get', '(key, default)'], ['replace', '(old, new, count)'], ['lower', '()'], ['upper', '()'], ['startswith', '(prefix)'],
    ['endswith', '(suffix)'], ['find', '(sub)'], ['count', '(value)'], ['index', '(value)'], ['pop', '(index)'], ['sort', '(key, reverse)'], ['extend', '(iterable)'],
    ['insert', '(index, object)'], ['remove', '(value)'], ['update', '(other)'], ['copy', '()'], ['clear', '()'], ['read', '()'], ['write', '(text)'],
    ['readlines', '()'], ['close', '()'], ['add', '(element)'], ['setdefault', '(key, default)'], ['rstrip', '(chars)'], ['lstrip', '(chars)'],
    ['splitlines', '()'], ['encode', '(encoding)'], ['decode', '(encoding)'], ['isdigit', '()'], ['isalpha', '()'], ['title', '()'], ['capitalize', '()'],
    ['reverse', '()'], ['sqrt', '(x)'], ['pi'], ['floor', '(x)'], ['ceil', '(x)'], ['randint', '(a, b)'], ['choice', '(seq)'], ['random', '()'], ['shuffle', '(x)'],
    ['path'], ['exists', '(path)'], ['listdir', '(path)'], ['getcwd', '()'], ['argv'], ['exit', '(code)'], ['dumps', '(obj)'], ['loads', '(s)'], ['load', '(fp)'],
    ['dump', '(obj, fp)'], ['sleep', '(seconds)'], ['time', '()'], ['now', '()'], ['search', '(pattern, string)'], ['match', '(pattern, string)'],
    ['findall', '(pattern, string)'], ['sub', '(pattern, repl, string)'],
  ],
}

const javascript: Vocabulary = {
  builtins: [
    ['console'], ['log', '(...data)'], ['document'], ['window'], ['Math'], ['JSON'], ['Array'], ['Object'], ['String'], ['Number'], ['Promise'],
    ['setTimeout', '(handler, timeout)'], ['setInterval', '(handler, timeout)'], ['clearTimeout', '(id)'], ['fetch', '(input, init)'],
    ['parseInt', '(string, radix)'], ['parseFloat', '(string)'], ['Date'], ['Map'], ['Set'], ['Error'], ['Boolean'], ['RegExp'], ['Symbol'],
    ['require', '(id)'], ['module'], ['exports'], ['process'], ['undefined'], ['NaN'], ['Infinity'], ['isNaN', '(number)'], ['localStorage'],
  ],
  keywords: ['const', 'let', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'import', 'export', 'from', 'default', 'class', 'new',
    'this', 'true', 'false', 'null', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'switch', 'case', 'break',
    'continue', 'extends', 'super', 'var', 'do', 'void', 'delete', 'yield', 'static', 'get', 'set', 'interface', 'type', 'enum', 'implements'],
  members: [
    ['log', '(...data)'], ['length'], ['push', '(...items)'], ['map', '(callback)'], ['filter', '(callback)'], ['forEach', '(callback)'], ['join', '(separator)'],
    ['split', '(separator)'], ['then', '(onFulfilled)'], ['catch', '(onRejected)'], ['includes', '(value)'], ['indexOf', '(value)'], ['slice', '(start, end)'],
    ['reduce', '(callback, initial)'], ['find', '(callback)'], ['keys', '(obj)'], ['values', '(obj)'], ['entries', '(obj)'], ['stringify', '(value)'],
    ['parse', '(text)'], ['getElementById', '(id)'], ['querySelector', '(selectors)'], ['addEventListener', '(type, listener)'], ['toString', '()'],
    ['replace', '(pattern, replacement)'], ['trim', '()'], ['toLowerCase', '()'], ['toUpperCase', '()'], ['floor', '(x)'], ['random', '()'], ['round', '(x)'],
    ['max', '(...values)'], ['min', '(...values)'], ['abs', '(x)'], ['error', '(...data)'], ['warn', '(...data)'], ['pop', '()'], ['shift', '()'],
    ['splice', '(start, deleteCount)'], ['sort', '(compare)'], ['some', '(callback)'], ['every', '(callback)'], ['concat', '(...items)'], ['assign', '(target, ...sources)'],
  ],
}

const java: Vocabulary = {
  builtins: [
    ['System'], ['String'], ['Integer'], ['Math'], ['List'], ['ArrayList', '<>()'], ['Map'], ['HashMap', '<>()'], ['Scanner', '(System.in)'],
    ['Arrays'], ['Collections'], ['Set'], ['HashSet', '<>()'], ['Object'], ['Double'], ['Boolean'], ['Character'], ['Long'], ['StringBuilder', '()'],
    ['Exception', '(message)'], ['RuntimeException', '(message)'], ['IllegalArgumentException', '(message)'], ['Override'], ['Thread'], ['Random', '()'],
    ['Optional'], ['Stream'], ['LinkedList', '<>()'], ['Iterator'], ['main', '(String[] args)'],
  ],
  keywords: ['public', 'private', 'protected', 'static', 'final', 'void', 'int', 'double', 'boolean', 'char', 'long', 'float', 'byte', 'short',
    'class', 'interface', 'enum', 'record', 'extends', 'implements', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'this', 'super', 'null', 'true', 'false', 'instanceof',
    'abstract', 'synchronized', 'var'],
  members: [
    ['out'], ['println', '(x)'], ['print', '(x)'], ['printf', '(format, ...args)'], ['length', '()'], ['size', '()'], ['add', '(e)'], ['get', '(index)'],
    ['put', '(key, value)'], ['equals', '(obj)'], ['toString', '()'], ['parseInt', '(s)'], ['valueOf', '(x)'], ['charAt', '(index)'], ['substring', '(begin, end)'],
    ['contains', '(o)'], ['remove', '(o)'], ['isEmpty', '()'], ['nextInt', '()'], ['nextLine', '()'], ['next', '()'], ['hasNext', '()'], ['append', '(x)'],
    ['split', '(regex)'], ['sort', '(list)'], ['max', '(a, b)'], ['min', '(a, b)'], ['abs', '(a)'], ['sqrt', '(a)'], ['pow', '(a, b)'], ['random', '()'],
    ['keySet', '()'], ['values', '()'], ['entrySet', '()'], ['getKey', '()'], ['getValue', '()'], ['stream', '()'], ['forEach', '(action)'], ['trim', '()'],
    ['toUpperCase', '()'], ['toLowerCase', '()'], ['indexOf', '(o)'], ['containsKey', '(key)'], ['getOrDefault', '(key, default)'], ['close', '()'],
  ],
}

const vocabularies: Record<string, Vocabulary> = { python, javascript, typescript: javascript, jsx: javascript, tsx: javascript, java }

// Names this file defines (functions, classes, variables, parameters), from the syntax tree.
const definitionNames = new Set(['VariableDefinition', 'Definition'])
function fileNames(context: CompletionContext, word: string) {
  const counts = new Map<string, { count: number; defined: boolean; kind: string; signature?: string }>()
  const doc = context.state.doc
  const text = doc.length > 300_000 ? doc.sliceString(Math.max(0, context.pos - 150_000), context.pos + 150_000) : doc.toString()
  // Every identifier-like word in the file counts as a candidate; repeats rank higher.
  for (const match of text.matchAll(/[A-Za-z_$][\w$]{1,}/g)) {
    const name = match[0]
    const entry = counts.get(name)
    if (entry) entry.count++
    else counts.set(name, { count: 1, defined: false, kind: 'text' })
  }
  // Mark the ones the file defines, and keep function signatures.
  syntaxTree(context.state).iterate({
    enter: node => {
      const parent = node.node.parent
      let kind = ''
      if (definitionNames.has(node.name)) kind = parent?.name.includes('Function') || parent?.name.includes('Method') ? 'function' : parent?.name.includes('Class') ? 'class' : 'variable'
      else if (node.name === 'VariableName' && parent && (parent.name === 'FunctionDefinition' || parent.name === 'ClassDefinition') && node.node.prevSibling && /^(def|class)$/.test(node.node.prevSibling.name)) kind = parent.name === 'FunctionDefinition' ? 'function' : 'class'
      else if (node.name === 'VariableName' && parent && (parent.name === 'AssignStatement' || parent.name === 'ParamList' || parent.name === 'ForStatement')) kind = 'variable'
      if (!kind) return
      const name = doc.sliceString(node.from, node.to)
      const entry = counts.get(name)
      if (!entry) return
      entry.defined = true
      if (entry.kind !== 'function' && entry.kind !== 'class') entry.kind = kind
      if (kind === 'function' || kind === 'class') {
        const params = parent?.getChild('ParamList') ?? parent?.getChild('FormalParameters')
        if (params) entry.signature = doc.sliceString(params.from, Math.min(params.to, params.from + 60)).replace(/\s+/g, ' ')
      }
    },
  })
  counts.delete(word)
  return counts
}

const rank = (index: number, length: number) => 1 - index / Math.max(1, length)

/** The completion source: typed prefix in, ranked names out. */
export function smartCompletions(languageName: string): CompletionSource {
  const vocabulary = vocabularies[languageName] ?? { builtins: [], keywords: [], members: [] }
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_$][\w$]*/)
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    // No suggestions inside strings and comments.
    if (/String|Comment|Docstring/.test(node.name) || (node.parent && /String|Comment/.test(node.parent.name))) return null
    const afterDot = context.matchBefore(/\.\s*[\w$]*$/) !== null
    if (!word && !context.explicit && !afterDot) return null
    const typed = word?.text ?? ''
    if (!context.explicit && typed.length < 1 && !afterDot) return null
    const from = word?.from ?? context.pos
    const lower = typed.toLowerCase()
    const matches = (name: string) => name.length > typed.length && (name.startsWith(typed) || name.toLowerCase().startsWith(lower)) || (context.explicit && !typed)
    const scored = new Map<string, Completion & { score: number }>()
    const add = (option: Completion, score: number) => {
      const exactCase = option.label.startsWith(typed) ? 0.6 : 0
      const total = score + exactCase - option.label.length * 0.004
      const previous = scored.get(option.label)
      if (!previous || previous.score < total) scored.set(option.label, { ...option, score: total })
    }
    const names = fileNames(context, typed)
    if (afterDot) {
      // After a dot: names used after dots in this file, then common members.
      const doc = context.state.doc.toString()
      const used = new Map<string, number>()
      for (const match of doc.matchAll(/\.([A-Za-z_$][\w$]*)/g)) if (match[1] !== typed) used.set(match[1], (used.get(match[1]) ?? 0) + 1)
      for (const [name, count] of used) if (matches(name)) add({ label: name, type: 'property', ['source' as never]: 'this file' } as Completion, 2.4 + Math.min(1, count / 6))
      vocabulary.members.forEach(([name, signature], index) => { if (matches(name)) add({ label: name, type: signature?.startsWith('(') ? 'method' : 'property', detail: signature, ['source' as never]: 'common' } as Completion, 1.5 + rank(index, vocabulary.members.length)) })
    } else {
      for (const [name, info] of names) {
        if (!matches(name)) continue
        // Names this file defines rank high, then names it uses a lot.
        add({ label: name, type: info.defined ? info.kind : 'text', detail: info.signature, ['source' as never]: info.defined ? 'this file' : '' } as Completion, (info.defined ? 2.6 : 1.1) + Math.min(.8, info.count / 10))
      }
      vocabulary.builtins.forEach(([name, signature], index) => {
        if (matches(name)) add({ label: name, type: signature?.startsWith('(') || signature?.startsWith('<') ? 'function' : /^[A-Z]/.test(name) ? 'class' : 'variable', detail: signature, ['source' as never]: 'builtins' } as Completion, 1.6 + rank(index, vocabulary.builtins.length) * 1.2)
      })
      vocabulary.keywords.forEach((name, index) => { if (matches(name)) add({ label: name, type: 'keyword', ['source' as never]: 'keyword' } as Completion, 1.4 + rank(index, vocabulary.keywords.length)) })
    }
    const options = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 40)
      .map((option, index) => ({ ...option, boost: 99 - Math.min(198, index) }))
    if (!options.length) return null
    return { from, options, filter: false }
  }
}

/** Shows where a suggestion comes from, right-aligned, like other IDEs. */
export const sourceColumn = {
  render: (completion: Completion) => {
    const source = (completion as unknown as { source?: string }).source
    if (!source) return null
    const node = document.createElement('span')
    node.className = 'cm-completionSource'
    node.textContent = source
    return node
  },
  position: 90,
}
