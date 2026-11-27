// Word suggestions that rank like a real IDE: only names that start with what you typed,
// your own names and the most common built-ins first, each with its signature and where
// it comes from ("builtins", "this file", "keyword"). Replaces CodeMirror's fuzzy lists,
// which offer `property` and `PermissionError` when you type "pri".
import { type Completion, type CompletionContext, type CompletionResult, type CompletionSource, closeCompletion, snippet, snippetCompletion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
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
// Snippets: type the prefix, press Tab, then Tab again to move between the parts to fill in.
export interface Snippet { prefix: string; body: string; description: string; language: string }
const builtinSnippets: Snippet[] = [
  { language: 'python', prefix: 'main', description: 'Run main() when the file is run directly', body: 'def main() -> None:\n\t${pass}\n\n\nif __name__ == "__main__":\n\tmain()' },
  { language: 'python', prefix: 'ifmain', description: 'if __name__ == "__main__"', body: 'if __name__ == "__main__":\n\t${main()}' },
  { language: 'python', prefix: 'def', description: 'Function', body: 'def ${name}(${params}):\n\t${pass}' },
  { language: 'python', prefix: 'class', description: 'Class with __init__', body: 'class ${Name}:\n\tdef __init__(self${, value}):\n\t\t${pass}' },
  { language: 'python', prefix: 'for', description: 'for … in …', body: 'for ${item} in ${items}:\n\t${pass}' },
  { language: 'python', prefix: 'fori', description: 'for i in range(n)', body: 'for ${i} in range(${n}):\n\t${pass}' },
  { language: 'python', prefix: 'while', description: 'while loop', body: 'while ${condition}:\n\t${pass}' },
  { language: 'python', prefix: 'if', description: 'if / else', body: 'if ${condition}:\n\t${pass}\nelse:\n\t${pass}' },
  { language: 'python', prefix: 'try', description: 'try / except', body: 'try:\n\t${pass}\nexcept ${Exception} as ${error}:\n\t${raise}' },
  { language: 'python', prefix: 'with', description: 'Open a file', body: 'with open(${"path"}) as ${file}:\n\t${text = file.read()}' },
  { language: 'python', prefix: 'test', description: 'pytest test function', body: 'def test_${name}():\n\t${assert True}' },
  { language: 'python', prefix: 'dataclass', description: 'Dataclass', body: 'from dataclasses import dataclass\n\n\n@dataclass\nclass ${Name}:\n\t${field}: ${int}' },
  { language: 'python', prefix: 'prop', description: 'Property', body: '@property\ndef ${name}(self):\n\treturn self._${name}' },
  { language: 'python', prefix: 'lc', description: 'List comprehension', body: '[${x} for ${x} in ${items}]' },
  { language: 'java', prefix: 'psvm', description: 'public static void main', body: 'public static void main(String[] args) {\n\t${}\n}' },
  { language: 'java', prefix: 'main', description: 'public static void main', body: 'public static void main(String[] args) {\n\t${}\n}' },
  { language: 'java', prefix: 'sout', description: 'System.out.println', body: 'System.out.println(${});' },
  { language: 'java', prefix: 'serr', description: 'System.err.println', body: 'System.err.println(${});' },
  { language: 'java', prefix: 'souf', description: 'System.out.printf', body: 'System.out.printf("${}%n"${});' },
  { language: 'java', prefix: 'soutv', description: 'Print a variable with its name', body: 'System.out.println("${1:value} = " + ${1:value});' },
  { language: 'java', prefix: 'fori', description: 'for (int i …)', body: 'for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}' },
  { language: 'java', prefix: 'foreach', description: 'for (Type item : items)', body: 'for (${String} ${item} : ${items}) {\n\t${}\n}' },
  { language: 'java', prefix: 'if', description: 'if / else', body: 'if (${condition}) {\n\t${}\n} else {\n\t${}\n}' },
  { language: 'java', prefix: 'while', description: 'while loop', body: 'while (${condition}) {\n\t${}\n}' },
  { language: 'java', prefix: 'try', description: 'try / catch', body: 'try {\n\t${}\n} catch (${Exception} ${e}) {\n\t${e}.printStackTrace();\n}' },
  { language: 'java', prefix: 'class', description: 'Class', body: 'public class ${Name} {\n\t${}\n}' },
  { language: 'java', prefix: 'method', description: 'Method', body: 'public ${void} ${name}(${}) {\n\t${}\n}' },
  { language: 'javascript', prefix: 'log', description: 'console.log', body: 'console.log(${})' },
  { language: 'javascript', prefix: 'fn', description: 'Function', body: 'function ${name}(${params}) {\n\t${}\n}' },
  { language: 'javascript', prefix: 'af', description: 'Arrow function', body: 'const ${name} = (${params}) => {\n\t${}\n}' },
  { language: 'javascript', prefix: 'forof', description: 'for … of …', body: 'for (const ${item} of ${items}) {\n\t${}\n}' },
  { language: 'javascript', prefix: 'if', description: 'if / else', body: 'if (${condition}) {\n\t${}\n} else {\n\t${}\n}' },
  { language: 'javascript', prefix: 'try', description: 'try / catch', body: 'try {\n\t${}\n} catch (${error}) {\n\t${console.error(error)}\n}' },
  { language: 'javascript', prefix: 'imp', description: 'import', body: "import ${name} from '${module}'" },
  { language: 'latex', prefix: 'begin', description: 'environment', body: '\\begin{${env}}\n\t${}\n\\end{${env}}' },
  { language: 'latex', prefix: 'doc', description: 'document skeleton', body: '\\documentclass{article}\n\\usepackage{amsmath}\n\n\\title{${Title}}\n\\author{${Author}}\n\n\\begin{document}\n\\maketitle\n\n${}\n\n\\end{document}' },
  { language: 'latex', prefix: 'sec', description: 'section', body: '\\section{${title}}\n${}' },
  { language: 'latex', prefix: 'eq', description: 'equation', body: '\\begin{equation}\n\t${}\n\\end{equation}' },
  { language: 'latex', prefix: 'align', description: 'aligned equations', body: '\\begin{align}\n\t${a} &= ${b} \\\\\n\\end{align}' },
  { language: 'latex', prefix: 'item', description: 'itemize list', body: '\\begin{itemize}\n\t\\item ${}\n\\end{itemize}' },
  { language: 'latex', prefix: 'enum', description: 'numbered list', body: '\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}' },
  { language: 'latex', prefix: 'fig', description: 'figure', body: '\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}' },
  { language: 'latex', prefix: 'frac', description: 'fraction', body: '\\frac{${a}}{${b}}' },
]
let customSnippets: Snippet[] = []
/** Snippets from Settings → Editor → Snippets. */
export function setCustomSnippets(list: Snippet[]) { customSnippets = Array.isArray(list) ? list.filter(item => item && item.prefix && item.body) : [] }
export function snippetsFor(languageName: string) {
  return [...customSnippets, ...builtinSnippets].filter(item => item.language === languageName || item.language === 'any' || !item.language)
}

/** Expands the snippet whose name is right before the caret (`sout`, `ifmain`…). False when there's none. */
export function expandSnippetBefore(view: EditorView, languageName: string): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(range.head)
  const before = state.sliceDoc(line.from, range.head)
  const word = /[A-Za-z_][\w]*$/.exec(before)
  if (!word) return false
  const from = range.head - word[0].length
  const previous = state.sliceDoc(from - 1, from)
  // Not a member (obj.log), and not inside strings or comments.
  if (previous === '.' || /String|Comment|Docstring/.test(syntaxTree(state).resolveInner(range.head, -1).name)) return false
  const found = snippetsFor(languageName).find(item => item.prefix === word[0])
  if (!found) return false
  const body = found.body.startsWith('\\') && previous === '\\' ? found.body.slice(1) : found.body
  closeCompletion(view)
  snippet(body)(view, null, from, range.head)
  return true
}

// ---- self. / cls. / this.: the members of the class you're in ----
export interface Member { name: string; kind: 'method' | 'property'; detail?: string }
const notMembers = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'else', 'try', 'do', 'super', 'this', 'synchronized', 'constructor'])

/** The receiver before the dot, when it means "this object". */
export function receiverIsSelf(context: CompletionContext, languageName: string) {
  const match = context.matchBefore(/\b(self|cls|this)\s*\.\s*[\w$#]*$/)
  if (!match) return false
  const word = /^(\w+)/.exec(match.text)![1]
  return languageName.toLowerCase() === 'python' ? word === 'self' || word === 'cls' : word === 'this'
}

/** Fields and methods of the class around `pos` (and of parent classes in the same file). */
export function classMembers(state: CompletionContext['state'], pos: number, languageName: string): Member[] {
  const doc = state.doc
  const text = doc.toString()
  const python = languageName.toLowerCase() === 'python'
  // The class: from the syntax tree, or (Python) the nearest less-indented `class` line above.
  let node = syntaxTree(state).resolveInner(pos, -1) as ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null
  while (node && !/^(ClassDefinition|ClassDeclaration|ClassExpression|RecordDeclaration|EnumDeclaration|ObjectDeclaration|InterfaceDeclaration)$/.test(node.name)) node = node.parent
  let from: number, to: number
  if (node) { from = node.from; to = node.to }
  else if (python) {
    const line = doc.lineAt(pos)
    const indent = /^\s*/.exec(line.text)![0].length
    let found = -1
    for (let number = line.number; number >= 1; number--) {
      const row = doc.line(number).text
      const match = /^(\s*)class\s+\w+/.exec(row)
      if (match && match[1].length < indent) { found = number; break }
    }
    if (found < 0) return []
    from = doc.line(found).from
    const classIndent = /^\s*/.exec(doc.line(found).text)![0].length
    let end = found + 1
    while (end <= doc.lines && (!doc.line(end).text.trim() || /^\s*/.exec(doc.line(end).text)![0].length > classIndent)) end++
    to = end <= doc.lines ? doc.line(end).from : doc.length
  } else return []
  return membersInRange(text, from, to, python, 0)
}

/** Fields and methods declared in text[from, to) (a class), plus parent classes found in the same text. */
export function membersInRange(text: string, from: number, to: number, python: boolean, depth: number): Member[] {
  const members = new Map<string, Member>()
  const add = (name: string, kind: Member['kind'], detail?: string) => {
    if (!name || notMembers.has(name) || (python && /^__\w+__$/.test(name))) return
    const known = members.get(name)
    if (!known || (known.kind === 'property' && kind === 'method')) members.set(name, { name, kind, detail })
  }
  const parents: string[] = []
  const body = text.slice(from, to)
  if (python) {
    const header = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?/.exec(body)
    if (header?.[2]) parents.push(...header[2].split(',').map(item => item.trim().split('.').at(-1) ?? '').filter(item => /^\w+$/.test(item)))
    const lines = body.split('\n')
    const bodyIndent = lines.slice(1).find(line => line.trim())?.match(/^\s*/)?.[0].length ?? 4
    let property = false
    for (const line of lines.slice(1)) {
      const indent = /^\s*/.exec(line)![0].length
      if (indent === bodyIndent) {
        if (/^\s*@property\b/.test(line)) { property = true; continue }
        const method = /^\s*(?:async\s+)?def\s+(\w+)\s*\(\s*(?:self|cls)?\s*,?\s*([^)]*)\)?/.exec(line)
        if (method) { add(method[1], property ? 'property' : 'method', property ? undefined : '(' + method[2].replace(/\s+/g, ' ').slice(0, 50) + ')'); property = false; continue }
        const field = /^\s*(\w+)\s*(?::[^=]+)?=(?!=)/.exec(line)
        if (field) add(field[1], 'property')
        if (!/^\s*@/.test(line)) property = false
      }
      for (const match of line.matchAll(/\b(?:self|cls)\.(\w+)\s*(?::[^=]+)?=(?!=)/g)) add(match[1], 'property')
    }
  } else {
    const header = /\b(?:class|record|enum|interface|object)\s+(\w+)[^{]*?\b(?:extends|:)\s*([\w.]+)/.exec(body.slice(0, body.indexOf('{') + 1 || 400))
    if (header?.[2]) parents.push(header[2].split('.').at(-1)!)
    const className = /\b(?:class|record|enum|interface|object)\s+(\w+)/.exec(body)?.[1]
    // Lines directly in the class body: brace depth 1 (strings and comments roughly skipped).
    let depth = 0, line = '', start = true
    const flush = () => {
      if (depth === 1 && line.trim()) {
        const clean = line.replace(/\/\/.*$/, '').replace(/@\w+(\([^)]*\))?/g, '').trim()
        const method = /([A-Za-z_$#][\w$]*)\s*(<[^>]*>)?\s*\(([^)]*)\)?/.exec(clean)
        const isMethod = method && !/[=]/.test(clean.slice(0, method.index)) && !/^(return|new|throw)\b/.test(clean)
        if (isMethod && method[1] !== className) add(method[1].replace(/^#/, ''), 'method', '(' + (method[3] ?? '').replace(/\s+/g, ' ').slice(0, 50) + ')')
        else {
          const field = /([A-Za-z_$#][\w$]*)\s*[?!]?\s*(?::[^=;]+)?(?:=|;|$)/.exec(clean.replace(/^(?:(?:public|private|protected|static|final|readonly|transient|volatile|internal|override|abstract|declare|val|var|let|const)\s+)*(?:[\w<>\[\],.?]+\s+(?=[A-Za-z_$#][\w$]*\s*(=|;)))?/, ''))
          // A field may be set with a call (= new ArrayList<>()); only a ( before the = means a method.
          if (field && !/\(/.test(clean.split('=')[0])) add(field[1].replace(/^#/, ''), 'property')
        }
      }
      line = ''
    }
    for (let index = body.indexOf('{'); index >= 0 && index < body.length; index++) {
      const char = body[index]
      if (char === '/' && body[index + 1] === '/') { while (index < body.length && body[index] !== '\n') index++; flush(); continue }
      if (char === '/' && body[index + 1] === '*') { index = body.indexOf('*/', index + 2); if (index < 0) break; index++; continue }
      if (char === '"' || char === "'" || char === '`') { const close = body.indexOf(char, index + 1); line += char + char; index = close < 0 ? body.length : close; continue }
      if (char === '{') { if (depth === 1) flush(); depth++; start = true; continue }
      if (char === '}') { if (depth === 1) flush(); depth--; if (depth === 0) break; continue }
      if ((char === ';' || char === '\n') && depth === 1) { if (char === ';') line += ';'; flush(); continue }
      if (depth === 1) line += char
      start = false
    }
    void start
    for (const match of body.matchAll(/\bthis\.([A-Za-z_$#][\w$]*)\s*=(?!=)/g)) add(match[1].replace(/^#/, ''), 'property')
  }
  // Parent classes defined in the same text.
  if (depth < 3) for (const parent of parents.slice(0, 3)) {
    const range = findClassRange(text, parent, python)
    if (!range || (range.from >= from && range.from < to)) continue
    for (const member of membersInRange(text, range.from, range.to, python, depth + 1)) if (!members.has(member.name)) members.set(member.name, member)
  }
  return [...members.values()]
}

/** Where `class Name` is declared in text: from its header to the end of its body. */
export function findClassRange(text: string, name: string, python: boolean): { from: number; to: number } | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  if (python) {
    const match = new RegExp('^([ \\t]*)class\\s+' + name + '\\b', 'm').exec(text)
    if (!match) return null
    const indent = match[1].length
    const lines = text.slice(match.index).split('\n')
    let length = lines[0].length + 1
    for (const line of lines.slice(1)) {
      if (line.trim() && /^\s*/.exec(line)![0].length <= indent) break
      length += line.length + 1
    }
    return { from: match.index, to: Math.min(text.length, match.index + length) }
  }
  const match = new RegExp('\\b(?:class|interface|record|enum|object|struct)\\s+' + name.replace(/\$/g, '\\$') + '\\b').exec(text)
  if (!match) return null
  const open = text.indexOf('{', match.index)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end; continue }
    if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 1; continue }
    if (char === '"' || char === "'" || char === '`') { let end = index + 1; while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1; index = end; continue }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return { from: match.index, to: index + 1 }
  }
  return { from: match.index, to: text.length }
}

const typeNoise = new Set(['return', 'new', 'else', 'case', 'throw', 'import', 'package', 'var', 'val', 'let', 'const', 'final', 'static', 'public', 'private', 'protected', 'in', 'of', 'instanceof', 'yield', 'await', 'print'])
const builtinTypes = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double', 'void', 'String', 'str', 'bool', 'number', 'string', 'any', 'object', 'Object', 'Integer', 'list', 'dict', 'set', 'tuple'])

/**
 * The class of the name before the dot, worked out from this file: `Robot robot`, `robot: Robot`,
 * `robot = Robot(...)`, `var robot = new Robot()`, a field assigned through self./this., or the
 * class name itself (`Robot.`). Null when it can't tell.
 */
export function receiverType(text: string, receiver: string, pos: number, python: boolean): string | null {
  const name = receiver.replace(/^(?:self|this|cls)\./, '')
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  if (/^[A-Z]/.test(name) && findClassRange(text, name, python)) return name
  const before = text.slice(0, pos)
  const escaped = name.replace(/\$/g, '\\$')
  const candidates: { at: number; type: string }[] = []
  const collect = (pattern: RegExp, group = 1) => {
    for (const match of text.matchAll(pattern)) {
      const type = match[group]?.split('.').at(-1)
      if (!type || typeNoise.has(type) || builtinTypes.has(type)) continue
      candidates.push({ at: match.index ?? 0, type })
    }
  }
  // Typed declarations and parameters (Java, C#, Kotlin-less): `Robot robot`, `List<Robot> robots` skipped.
  if (!python) collect(new RegExp('\\b([A-Z][\\w$]*(?:\\.[A-Z][\\w$]*)*)(?:<[^<>;()]*>)?\\s+' + escaped + '\\s*(?=[=;,)]|$|:)', 'gm'))
  // Annotations: `robot: Robot` (Python, TypeScript, Kotlin).
  collect(new RegExp('(?:^|[\\s(,])(?:self\\.|this\\.)?' + escaped + '\\s*\\??:\\s*(?:Optional\\[)?([A-Za-z_][\\w.]*)', 'gm'))
  // Assignments from a constructor: `robot = Robot(...)`, `robot = new Robot(...)`.
  collect(new RegExp('(?:^|[^\\w$.])(?:self\\.|this\\.)?' + escaped + '\\s*=\\s*(?:new\\s+)?([A-Z][\\w$.]*)\\s*(?:<[^>]*>)?\\(', 'gm'))
  if (!candidates.length) return null
  // The closest declaration above the caret wins, else the first one in the file.
  const above = candidates.filter(item => item.at < before.length).sort((a, b) => b.at - a.at)
  return (above[0] ?? candidates.sort((a, b) => a.at - b.at)[0]).type
}

/** The name (or self.name / this.name) right before the dot at the caret, if not self/this itself. */
export function receiverBeforeDot(context: CompletionContext): string | null {
  const match = context.matchBefore(/(?:\b(?:self|this|cls)\.)?[A-Za-z_$][\w$]*\s*\.\s*[\w$]*$/)
  if (!match) return null
  const receiver = /^((?:(?:self|this|cls)\.)?[A-Za-z_$][\w$]*)/.exec(match.text)![1]
  if (/^(self|this|cls|super)$/.test(receiver)) return null
  // Not the middle of a longer chain like a.b.c (only the first link can be typed from the file).
  const start = match.from
  if (start > 0 && /[.\w$]/.test(context.state.sliceDoc(start - 1, start)) && !/^(self|this|cls)\./.test(receiver)) return null
  return receiver
}

/** Finds the source of a class defined elsewhere in the project (set by the IDE). */
type ClassSource = (name: string, fromPath: string, fileText: string) => Promise<{ text: string; python: boolean } | null>
let classSource: ClassSource | null = null
export function setClassSource(source: ClassSource | null) { classSource = source }

/** Members of the class the receiver is an instance of: from this file, else from the project. */
export async function receiverMembers(text: string, receiver: string, pos: number, languageName: string, path: string): Promise<{ type: string; members: Member[] } | null> {
  const python = languageName.toLowerCase() === 'python'
  const type = receiverType(text, receiver, pos, python)
  if (!type) return null
  const local = findClassRange(text, type, python)
  if (local) return { type, members: membersInRange(text, local.from, local.to, python, 0) }
  const found = await classSource?.(type, path, text).catch(() => null)
  if (!found) return null
  const range = findClassRange(found.text, type, found.python)
  return range ? { type, members: membersInRange(found.text, range.from, range.to, found.python, 0) } : null
}

export function smartCompletions(languageName: string, path = ''): CompletionSource {
  const vocabulary = vocabularies[languageName] ?? { builtins: [], keywords: [], members: [] }
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
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
    if (afterDot && receiverIsSelf(context, languageName)) {
      // self. / this.: the class's own fields and methods first.
      for (const member of classMembers(context.state, context.pos, languageName)) {
        if (matches(member.name)) add({ label: member.name, type: member.kind, detail: member.detail, ['source' as never]: 'this class', ['member' as never]: true } as Completion, 3.6)
      }
    } else if (afterDot) {
      // robot. : the fields and methods of the variable's class, when the file says what it is.
      const receiver = receiverBeforeDot(context)
      const found = receiver ? await receiverMembers(context.state.doc.toString(), receiver, context.pos, languageName, path) : null
      if (context.aborted) return null
      if (found) for (const member of found.members) {
        if (matches(member.name)) add({ label: member.name, type: member.kind, detail: member.detail, ['source' as never]: found.type, ['member' as never]: true } as Completion, 3.6)
      }
    }
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
      // Snippets rank just above the keyword they're named after.
      const seen = new Set<string>()
      for (const snippet of snippetsFor(languageName)) {
        if (seen.has(snippet.prefix) || !(snippet.prefix.startsWith(typed) || snippet.prefix.toLowerCase().startsWith(lower)) || (!typed && !context.explicit)) continue
        seen.add(snippet.prefix)
        // A LaTeX command typed after its backslash: don't add a second one.
        const body = snippet.body.startsWith('\\') && context.state.sliceDoc(from - 1, from) === '\\' ? snippet.body.slice(1) : snippet.body
        const option = snippetCompletion(body, { label: snippet.prefix, detail: snippet.description, type: 'snippet' })
        const exact = snippet.prefix === typed ? 1.2 : 0
        scored.set(snippet.prefix + ' snippet', { ...option, ['source' as never]: 'snippet', score: 1.55 + exact - snippet.prefix.length * 0.004 } as Completion & { score: number })
      }
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
