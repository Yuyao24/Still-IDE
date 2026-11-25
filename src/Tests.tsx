import { useState } from 'react'
import { Check, CircleDashed, FlaskConical, Play, X } from 'lucide-react'
import { Icon } from './ui'

export interface TestResult { name: string; group: string; file: string | null; line: number | null; status: 'passed' | 'failed' | 'error' | 'skipped'; message: string; seconds: number }
export interface TestReport { tool: string; results: TestResult[]; time: number }
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

export function TestsPanel({ report, running, onRun, onJump, canRun, why }: {
  report: TestReport | null; running: boolean; canRun: boolean; why?: string
  onRun: (target: 'all' | 'failed' | 'file') => void; onJump: (result: TestResult) => void
}) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const results = report?.results ?? []
  const failed = results.filter(result => result.status === 'failed' || result.status === 'error')
  const passed = results.filter(result => result.status === 'passed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = results.reduce((sum, result) => sum + result.seconds, 0)
  const shown = onlyFailed ? failed : results
  const groups = new Map<string, TestResult[]>()
  for (const result of shown) groups.set(result.file ?? result.group, [...(groups.get(result.file ?? result.group) ?? []), result])
  return <div className="tests">
    <div className="dbg-bar tests-bar">
      <button className="text-btn primary" disabled={!canRun || running} onClick={() => onRun('all')}><Icon glyph={Play} size={12} />Run all tests</button>
      <button className="text-btn" disabled={!canRun || running} onClick={() => onRun('file')}>This file</button>
      {failed.length > 0 && <button className="text-btn" disabled={!canRun || running} onClick={() => onRun('failed')}>Run failed</button>}
      <span className={'dbg-status' + (failed.length ? ' is-error' : '')}>
        {running ? 'Running tests…' : !report ? (canRun ? 'Run the tests to see results here. ▶ beside a test runs just that one.' : why) : `${passed} passed · ${failed.length} failed${skipped ? ' · ' + skipped + ' skipped' : ''} · ${seconds.toFixed(2)} s · ${report.tool}`}
      </span>
      {report && failed.length > 0 && <label className="tests-filter"><input type="checkbox" checked={onlyFailed} onChange={event => setOnlyFailed(event.target.checked)} /> Only failures</label>}
    </div>
    <div className="tests-list">
      {[...groups].map(([group, items]) => <section key={group}>
        <h3>{group}</h3>
        {items.map((result, index) => <div key={index} className={'test-row is-' + result.status}>
          <button onClick={() => onJump(result)} title={result.file ? result.file + (result.line ? ':' + result.line : '') : result.group}>
            <Icon glyph={result.status === 'passed' ? Check : result.status === 'skipped' ? CircleDashed : X} size={12} />
            <span>{result.name}</span><span className="dbg-type">{result.seconds ? result.seconds.toFixed(2) + ' s' : ''}</span>
          </button>
          {result.message && result.status !== 'passed' && <pre>{result.message}</pre>}
        </div>)}
      </section>)}
      {report && !results.length && <p className="dbg-empty tests-empty"><Icon glyph={FlaskConical} size={13} /> No tests were found. Python test files are named test_*.py; Java tests need Maven or Gradle.</p>}
    </div>
  </div>
}
