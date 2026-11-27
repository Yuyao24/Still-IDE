import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, CircleDashed, FlaskConical, Play, X } from 'lucide-react'
import { Icon } from './ui'

export interface TestResult { name: string; group: string; file: string | null; line: number | null; status: 'passed' | 'failed' | 'error' | 'skipped'; message: string; seconds: number }
export interface TestReport { tool: string; results: TestResult[]; time: number; coverage?: Record<string, { covered: number[]; missed: number[] }> | null }
export interface FoundTest { line: number; id: string; name: string }

/** Tests defined in a file: pytest/unittest functions and methods, or JUnit @Test methods. */
export function testsIn(path: string, text: string): FoundTest[] {
  const found: FoundTest[] = []
  const lines = text.split('\n')
  if (/(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path)) {
    let currentClass: string | null = null
    lines.forEach((line, index) => {
      const klass = /^class\s+(Test\w*)/.exec(line)
      if (klass) { currentClass = klass[1]; found.push({ line: index + 1, id: path + '::' + klass[1], name: klass[1] }); return }
      if (/^\S/.test(line) && !/^(class|@|#)/.test(line)) currentClass = null
      const fn = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line)
      if (fn) {
        const inClass = fn[1].length > 0 && currentClass
        found.push({ line: index + 1, id: inClass ? `${path}::${currentClass}::${fn[2]}` : `${path}::${fn[2]}`, name: fn[2] })
      }
    })
  } else if (path.endsWith('.java') && text.includes('@Test')) {
    const className = path.split('/').at(-1)!.replace(/\.java$/, '')
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1]
    const full = pkg ? pkg + '.' + className : className
    let pending = false
    lines.forEach((line, index) => {
      if (/@Test\b/.test(line)) { pending = true; return }
      const method = /\bvoid\s+(\w+)\s*\(/.exec(line)
      if (pending && method) { found.push({ line: index + 1, id: full + '#' + method[1], name: method[1] }); pending = false }
    })
    const classLine = lines.findIndex(line => new RegExp('\\bclass\\s+' + className + '\\b').test(line))
    if (found.length && classLine >= 0) found.unshift({ line: classLine + 1, id: full, name: className })
  }
  return found
}

/** The result for a test found in the editor, if the last run included it. */
export function resultFor(report: TestReport | null, path: string, test: FoundTest): TestResult['status'] | 'mixed' | undefined {
  if (!report) return undefined
  const module = path.replace(/\.py$/, '').replace(/\//g, '.')
  const mine = report.results.filter(result => result.file === path || result.group === module || result.group.startsWith(module + '.') || result.group.endsWith('.' + test.name) || result.group === test.id.split('#')[0])
  // A class line sums up its methods.
  const isClass = !test.id.includes('#') && /^Test|Test$/.test(test.name) && !test.name.startsWith('test')
  const matching = isClass ? mine.filter(result => result.group.endsWith(test.name) || result.group === test.id) : mine.filter(result => result.name === test.name || result.name.startsWith(test.name + '['))
  if (!matching.length) return undefined
  if (matching.some(result => result.status === 'failed' || result.status === 'error')) return 'failed'
  if (matching.every(result => result.status === 'skipped')) return 'skipped'
  return 'passed'
}

interface TestNode { key: string; label: string; id: string | null; results: TestResult[]; children: TestNode[] }

/** The class part of a result's group: TestShop in tests.test_shop.TestShop, CartTest in shop.CartTest. */
function classOf(result: TestResult) {
  const parts = result.group.split('.')
  const last = parts.at(-1) ?? ''
  return /^Test|Test$|Tests$/.test(last) && !/^test_/.test(last) ? last : null
}
/** What to pass to the runner to run just this node (pytest node id, or Class#method for JUnit). */
function idFor(result: TestResult, level: 'file' | 'class' | 'test') {
  if (result.file?.endsWith('.py') || (!result.file && !result.group.includes('#') && /\.py$|^test_/.test(result.group))) {
    const file = result.file ?? result.group.replace(/\./g, '/') + '.py'
    const klass = classOf(result)
    if (level === 'file') return file
    if (level === 'class') return klass ? file + '::' + klass : file
    return file + '::' + (klass ? klass + '::' : '') + result.name.replace(/\[.*$/, '')
  }
  if (level === 'test') return result.group + '#' + result.name.replace(/\(.*$/, '')
  return result.group
}
function tree(results: TestResult[]): TestNode[] {
  const files = new Map<string, TestNode>()
  for (const result of results) {
    const fileKey = result.file ?? result.group.split('.').filter(part => !/^Test|Test$|Tests$/.test(part)).join('.') ?? result.group
    let file = files.get(fileKey)
    if (!file) { file = { key: fileKey, label: fileKey || result.group, id: idFor(result, 'file'), results: [], children: [] }; files.set(fileKey, file) }
    file.results.push(result)
    const klass = classOf(result)
    let parent = file
    if (klass) {
      let node = file.children.find(child => child.key === fileKey + '::' + klass)
      if (!node) { node = { key: fileKey + '::' + klass, label: klass, id: idFor(result, 'class'), results: [], children: [] }; file.children.push(node) }
      node.results.push(result)
      parent = node
    }
    parent.children.push({ key: parent.key + '::' + result.name + '::' + parent.children.length, label: result.name, id: idFor(result, 'test'), results: [result], children: [] })
  }
  return [...files.values()]
}
const failedResult = (result: TestResult) => result.status === 'failed' || result.status === 'error'
function statusOf(node: TestNode): TestResult['status'] {
  if (node.results.some(failedResult)) return 'failed'
  if (node.results.every(result => result.status === 'skipped')) return 'skipped'
  return 'passed'
}

export function TestsPanel({ report, running, onRun, onRunId, onJump, canRun, why, coverage, onCoverage, watch, onWatch }: {
  report: TestReport | null; running: boolean; canRun: boolean; why?: string
  onRun: (target: 'all' | 'failed' | 'file') => void; onRunId: (id: string) => void; onJump: (result: TestResult) => void
  coverage: boolean; onCoverage: (value: boolean) => void
  watch: boolean; onWatch: (value: boolean) => void
}) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const results = report?.results ?? []
  const failed = results.filter(failedResult)
  const passed = results.filter(result => result.status === 'passed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = results.reduce((sum, result) => sum + result.seconds, 0)
  const nodes = useMemo(() => tree(onlyFailed ? failed : results), [report, onlyFailed])
  const toggle = (key: string) => setClosed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const row = (node: TestNode, depth: number): ReactNode => {
    const status = statusOf(node)
    const leaf = !node.children.length
    const result = leaf ? node.results[0] : null
    const open = !closed.has(node.key)
    const glyph = status === 'passed' ? Check : status === 'skipped' ? CircleDashed : X
    const count = leaf ? '' : `${node.results.filter(item => item.status === 'passed').length}/${node.results.length}`
    return <div key={node.key} className={'test-node is-' + status + (leaf ? ' is-leaf' : '')}>
      <div className="test-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {leaf ? <span className="test-twisty" /> : <button className="test-twisty" onClick={() => toggle(node.key)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}><Icon glyph={open ? ChevronDown : ChevronRight} size={12} /></button>}
        <button className="test-label" onClick={() => result ? onJump(result) : toggle(node.key)} title={result ? (result.file ? result.file + (result.line ? ':' + result.line : '') : result.group) : node.label}>
          <Icon glyph={glyph} size={12} /><span className={leaf ? '' : 'test-group'}>{node.label}</span>
          <span className="dbg-type">{result ? (result.seconds ? result.seconds.toFixed(2) + ' s' : '') : count}</span>
        </button>
        {node.id && <button className="test-run" disabled={!canRun || running} onClick={() => onRunId(node.id!)} title={'Run ' + node.label} aria-label={'Run ' + node.label}><Icon glyph={Play} size={11} /></button>}
      </div>
      {result?.message && result.status !== 'passed' && <pre style={{ marginLeft: 30 + depth * 14 }}>{result.message}</pre>}
      {!leaf && open && node.children.map(child => row(child, depth + 1))}
    </div>
  }
  return <div className="tests">
    <div className="dbg-bar tests-bar">
      <button className="text-btn primary" disabled={!canRun || running} onClick={() => onRun('all')}><Icon glyph={Play} size={12} />Run all tests</button>
      <button className="text-btn" disabled={!canRun || running} onClick={() => onRun('file')}>This file</button>
      {failed.length > 0 && <button className="text-btn" disabled={!canRun || running} onClick={() => onRun('failed')}>Run failed</button>}
      <span className={'dbg-status' + (failed.length ? ' is-error' : '')}>
        {running ? 'Running tests…' : !report ? (canRun ? 'Run the tests to see results here. ▶ beside a test runs just that one.' : why) : `${passed} passed · ${failed.length} failed${skipped ? ' · ' + skipped + ' skipped' : ''} · ${seconds.toFixed(2)} s · ${report.tool}`}
      </span>
      {report && failed.length > 0 && <label className="tests-filter"><input type="checkbox" checked={onlyFailed} onChange={event => setOnlyFailed(event.target.checked)} /> Only failures</label>}
      <label className={'tests-filter' + (report && failed.length > 0 ? ' is-next' : '')} title="Run the tests again each time you save a file"><input type="checkbox" checked={watch} disabled={!canRun && !watch} onChange={event => onWatch(event.target.checked)} /> Watch</label>
      <label className="tests-filter is-next" title="Measure which lines the tests run and mark them in the editor (pytest-cov for Python; JaCoCo for Java, fetched by Maven or Gradle)"><input type="checkbox" checked={coverage} onChange={event => onCoverage(event.target.checked)} /> Coverage{report?.coverage ? ' · ' + coveragePercent(report.coverage) + '%' : ''}</label>
    </div>
    <div className="tests-list">
      {nodes.map(node => row(node, 0))}
      {report && !results.length && <p className="dbg-empty tests-empty"><Icon glyph={FlaskConical} size={13} /> No tests were found. Python test files are named test_*.py; Java tests need Maven or Gradle.</p>}
    </div>
  </div>
}

function coveragePercent(coverage: Record<string, { covered: number[]; missed: number[] }>) {
  let covered = 0, total = 0
  for (const file of Object.values(coverage)) { covered += file.covered.length; total += file.covered.length + file.missed.length }
  return total ? Math.round(covered / total * 100) : 0
}
