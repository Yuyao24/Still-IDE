// The profiler's results: a flame graph (each bar a function, as wide as the time spent in it and
// everything it called; callers above callees) and a table of where time went in each function
// itself. Click a bar to zoom into it; double-click a bar or a row to open that line.
import { useMemo, useState } from 'react'
import { Flame, Play } from 'lucide-react'
import { Icon } from './ui'

export interface ProfileData {
  elapsed: number
  interval: number
  frames: { name: string; file: string; line: number; mine: boolean }[]
  samples: { stack: number[]; count: number }[]
}
interface Node { key: string; frame: number; total: number; self: number; children: Map<string, Node> }

function build(data: ProfileData): Node {
  const root: Node = { key: 'root', frame: -1, total: 0, self: 0, children: new Map() }
  for (const sample of data.samples) {
    root.total += sample.count
    let node = root
    for (const id of sample.stack) {
      const key = String(id)
      let child = node.children.get(key)
      if (!child) { child = { key: node.key + '/' + key, frame: id, total: 0, self: 0, children: new Map() }; node.children.set(key, child) }
      child.total += sample.count
      node = child
    }
    node.self += sample.count
  }
  return root
}

const ROW = 22
/** The flame graph laid out as positioned bars: x and width as fractions of the zoomed node. */
function bars(node: Node, total: number) {
  const out: { node: Node; depth: number; x: number; width: number }[] = []
  const walk = (current: Node, depth: number, x: number) => {
    const sorted = [...current.children.values()].sort((a, b) => b.total - a.total)
    let offset = x
    for (const child of sorted) {
      const width = child.total / total
      if (width > 0.002) out.push({ node: child, depth, x: offset, width })
      walk(child, depth + 1, offset)
      offset += width
    }
  }
  walk(node, 0, 0)
  return out
}

function hue(text: string) {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return Math.abs(hash) % 40
}

export function ProfilePanel({ data, path, running, canRun, why, onRun, onOpen }: {
  data: ProfileData | null; path: string | null; running: boolean; canRun: boolean; why?: string
  onRun: () => void; onOpen: (file: string, line: number) => void
}) {
  const tree = useMemo(() => data ? build(data) : null, [data])
  const [focus, setFocus] = useState<string | null>(null)
  const [hover, setHover] = useState<Node | null>(null)
  const zoomed = useMemo(() => {
    if (!tree) return null
    if (!focus) return tree
    const find = (node: Node): Node | null => node.key === focus ? node : [...node.children.values()].reduce<Node | null>((found, child) => found ?? find(child), null)
    return find(tree) ?? tree
  }, [tree, focus])
  const laid = useMemo(() => zoomed ? bars({ ...zoomed, children: zoomed === tree ? zoomed.children : new Map([[zoomed.key, zoomed]]) }, zoomed.total || 1) : [], [zoomed, tree])
  const seconds = (count: number) => data ? (count / Math.max(1, tree?.total ?? 1)) * data.elapsed : 0
  const top = useMemo(() => {
    if (!data || !tree) return []
    const selfBy = new Map<number, number>()
    const totalBy = new Map<number, number>()
    for (const sample of data.samples) {
      const last = sample.stack.at(-1)
      if (last !== undefined) selfBy.set(last, (selfBy.get(last) ?? 0) + sample.count)
      for (const id of new Set(sample.stack)) totalBy.set(id, (totalBy.get(id) ?? 0) + sample.count)
    }
    return [...selfBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, self]) => ({ id, frame: data.frames[id], self, total: totalBy.get(id) ?? self }))
  }, [data, tree])
  const label = (node: Node) => data?.frames[node.frame]
  const depth = laid.reduce((max, bar) => Math.max(max, bar.depth + 1), 0)
  const shown = hover ? label(hover) : null
  return <div className="profile">
    <div className="dbg-bar tests-bar">
      <button className="text-btn primary" disabled={!canRun || running} onClick={onRun}><Icon glyph={Play} size={12} />Profile this file</button>
      {focus && <button className="text-btn" onClick={() => setFocus(null)}>Show everything</button>}
      <span className="dbg-status">
        {running ? 'Running under the profiler…' : !data ? (canRun ? 'Runs the file and samples where time goes, about every millisecond.' : why)
          : `${path ?? ''} · ${data.elapsed.toFixed(2)} s · ${tree?.total ?? 0} samples`}
      </span>
    </div>
    {!data ? <p className="dbg-empty tests-empty"><Icon glyph={Flame} size={13} /> {canRun ? 'Profile a Python file to see a flame graph of where its time goes.' : why}</p> : <div className="profile-body">
      <div className="flame" style={{ height: Math.max(depth, 1) * ROW + 4 }} onMouseLeave={() => setHover(null)}>
        {laid.map(bar => {
          const frame = label(bar.node)
          if (!frame) return null
          const mine = frame.mine
          return <button key={bar.node.key} className={'flame-bar' + (mine ? ' is-mine' : '')}
            style={{ left: bar.x * 100 + '%', width: `calc(${bar.width * 100}% - 1px)`, top: bar.depth * ROW, ['--flame-hue' as string]: mine ? 20 + hue(frame.file) : 0 }}
            onMouseEnter={() => setHover(bar.node)} onClick={() => setFocus(bar.node.key)} onDoubleClick={() => onOpen(frame.file, frame.line)}
            title={`${frame.name} · ${frame.file}:${frame.line}`}>
            <span>{frame.name}</span>
          </button>
        })}
      </div>
      <p className="flame-hover">{shown && hover ? <><b>{shown.name}</b> · {shown.file}:{shown.line} · {seconds(hover.total).toFixed(3)} s with what it calls ({Math.round(hover.total / Math.max(1, zoomed?.total ?? 1) * 100)}%) · {seconds(hover.self).toFixed(3)} s in itself</> : 'Hover a bar for details; click to zoom in, double-click to open the line.'}</p>
      <table className="profile-table">
        <thead><tr><th scope="col">Function</th><th scope="col">Where</th><th scope="col">Itself</th><th scope="col">With calls</th></tr></thead>
        <tbody>
          {top.map(row => <tr key={row.id} onDoubleClick={() => onOpen(row.frame.file, row.frame.line)} className={row.frame.mine ? 'is-mine' : ''}>
            <td>{row.frame.name}</td><td>{row.frame.file.split(/[\\/]/).slice(-2).join('/')}:{row.frame.line}</td>
            <td>{seconds(row.self).toFixed(3)} s</td><td>{seconds(row.total).toFixed(3)} s</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
  </div>
}
