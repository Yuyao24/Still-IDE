import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { type Graph, type GraphNode, type Point, layout, neighbours } from './graph'
import { Segmented, Toggle } from './ui'

type Scope = 'all' | 'around' | 'changed'
interface Filters { tests: boolean; packages: boolean; data: boolean; lonely: boolean; labels: 'some' | 'all' | 'none'; spacing: number }

const defaultsFilters: Filters = { tests: true, packages: true, data: true, lonely: false, labels: 'some', spacing: 1 }
function storedFilters(): Filters {
  try { return { ...defaultsFilters, ...JSON.parse(localStorage.getItem('still.graph') ?? '{}') } } catch { return defaultsFilters }
}

/** Moves points toward new targets over a short, eased transition instead of jumping. */
function useEased(target: Map<string, Point>) {
  const [current, setCurrent] = useState(target)
  const shown = useRef(target)
  useEffect(() => {
    const from = shown.current
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !from.size) { shown.current = target; setCurrent(target); return }
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 240)
      const ease = 1 - (1 - t) ** 3
      const next = new Map<string, Point>()
      for (const [id, to] of target) {
        const was = from.get(id) ?? to
        next.set(id, { x: was.x + (to.x - was.x) * ease, y: was.y + (to.y - was.y) * ease })
      }
      shown.current = next
      setCurrent(next)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return current
}

const size = (node: GraphNode) => Math.round(6 + Math.sqrt(node.degree) * 2.6)

function visible(graph: Graph, filters: Filters, scope: Scope, active: string | undefined, changed: Set<string>) {
  let nodes = graph.nodes.filter(node => (filters.tests || node.group !== 'test') && (filters.packages || node.group !== 'package') && (filters.data || node.group !== 'data'))
  let ids = new Set(nodes.map(node => node.id))
  let edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))
  const reach = (seeds: string[], depth: number) => {
    const keep = new Set(seeds)
    let frontier = seeds
    for (let level = 0; level < depth; level++) {
      const next: string[] = []
      for (const edge of edges) {
        if (frontier.includes(edge.from) && !keep.has(edge.to)) { keep.add(edge.to); next.push(edge.to) }
        if (frontier.includes(edge.to) && !keep.has(edge.from)) { keep.add(edge.from); next.push(edge.from) }
      }
      frontier = next
    }
    return keep
  }
  if (scope === 'around' && active && ids.has(active)) ids = reach([active], 2)
  if (scope === 'changed') ids = reach([...changed].filter(id => ids.has(id)), 1)
  if (!filters.lonely && scope === 'all') {
    const linked = new Set(edges.flatMap(edge => [edge.from, edge.to]))
    ids = new Set([...ids].filter(id => linked.has(id) || id === active))
  }
  nodes = nodes.filter(node => ids.has(node.id))
  edges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))
  return { nodes, edges }
}

interface ViewProps {
  graph: Graph | null
  error?: string
  project: string
  active?: string
  changed: Set<string>
  onOpen: (path: string) => void
  onClose: () => void
}

/** The whole-project graph: one quiet surface, the canvas on the left and details on the right. */
export function GraphView({ graph, error, project, active, changed, onOpen, onClose }: ViewProps) {
  const [scope, setScope] = useState<Scope>('all')
  const [filters, setFilters] = useState(storedFilters)
  const [selected, setSelected] = useState<string | undefined>(active)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const set = (change: Partial<Filters>) => setFilters(value => { const next = { ...value, ...change }; try { localStorage.setItem('still.graph', JSON.stringify(next)) } catch { /* ignore */ } return next })

  const shown = useMemo(() => graph ? visible(graph, filters, scope, active, changed) : { nodes: [], edges: [] }, [graph, filters, scope, active, changed])
  const target = useMemo(() => layout(shown.nodes, shown.edges, filters.spacing), [shown, filters.spacing])
  const points = useEased(target)
  const focus = hover ?? selected
  const near = useMemo(() => {
    if (!focus) return null
    const set = new Set([focus])
    for (const edge of shown.edges) { if (edge.from === focus) set.add(edge.to); if (edge.to === focus) set.add(edge.from) }
    return set
  }, [focus, shown])
  const chosen = graph?.nodes.find(node => node.id === selected)
  const links = chosen && graph ? neighbours(graph, chosen.id) : null

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if ((event.key === 'Enter') && selected && !selected.startsWith('package:')) onOpen(selected)
      if (event.key === '0') setView({ x: 0, y: 0, k: 1 })
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [selected, onClose, onOpen])

  function wheel(event: React.WheelEvent) {
    const box = svg.current!.getBoundingClientRect()
    const px = (event.clientX - box.left) / box.width * 1000, py = (event.clientY - box.top) / box.height * 1000
    setView(value => {
      const k = Math.max(.4, Math.min(5, value.k * Math.exp(-event.deltaY * .0015)))
      return { k, x: px - (px - value.x) * (k / value.k), y: py - (py - value.y) * (k / value.k) }
    })
  }
  function down(event: ReactPointerEvent) {
    if ((event.target as Element).closest('[data-node]')) return
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }
  function move(event: ReactPointerEvent) {
    const start = drag.current
    if (!start) return
    const box = svg.current!.getBoundingClientRect()
    const dx = (event.clientX - start.x) / box.width * 1000, dy = (event.clientY - start.y) / box.height * 1000
    if (Math.abs(dx) + Math.abs(dy) > 1) start.moved = true
    start.x = event.clientX; start.y = event.clientY
    setView(value => ({ ...value, x: value.x + dx, y: value.y + dy }))
  }
  function up() {
    if (drag.current && !drag.current.moved) setSelected(undefined)
    drag.current = null
  }

  const label = (node: GraphNode) => filters.labels === 'all' || (filters.labels === 'some' && (node.degree >= 4 || near?.has(node.id) || node.id === active))

  return <div className="graph-view" role="dialog" aria-label="Project graph">
    <header className="graph-head">
      <span className="graph-crumbs"><b>Still</b><i>/</i>{project}<i>/</i>Graph</span>
      <nav className="under-tabs" aria-label="Graph scope">
        {([['all', 'Whole project'], ['around', 'Around this file'], ['changed', 'Changed files']] as [Scope, string][]).map(([value, text]) =>
          <button key={value} className={scope === value ? 'is-active' : ''} aria-pressed={scope === value} onClick={() => setScope(value)} disabled={value === 'around' && !active}>{text}</button>)}
      </nav>
      <button className="quiet-link" onClick={onClose}>Esc to return</button>
    </header>
    <div className="graph-body">
      <div className="graph-canvas">
        {!graph && <p className="graph-note">{error || 'Reading files…'}</p>}
        {graph && !shown.nodes.length && <p className="graph-note">{scope === 'changed' ? 'No changed files.' : 'No linked files yet. Imports and Markdown links appear here.'}</p>}
        <svg ref={svg} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" onWheel={wheel} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {shown.edges.map(edge => {
              const a = points.get(edge.from), b = points.get(edge.to)
              if (!a || !b) return null
              const lit = focus && (edge.from === focus || edge.to === focus)
              return <line key={edge.from + edge.to} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={'graph-edge' + (lit ? ' lit' : '') + (near && !lit ? ' dim' : '')} vectorEffect="non-scaling-stroke" />
            })}
            {shown.nodes.map(node => {
              const point = points.get(node.id)
              if (!point) return null
              const s = size(node) / Math.sqrt(view.k)
              const classes = ['graph-node', 'group-' + node.group, node.id === selected && 'selected', node.id === active && 'active', near && !near.has(node.id) && 'dim', changed.has(node.id) && 'changed'].filter(Boolean).join(' ')
              return <g key={node.id} data-node className={classes} transform={`translate(${point.x} ${point.y})`}
                onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(null)}
                onClick={() => setSelected(node.id)} onDoubleClick={() => { if (node.group !== 'package') onOpen(node.id) }}>
                <rect x={-s / 2 - 8} y={-s / 2 - 8} width={s + 16} height={s + 16} className="graph-hit" />
                <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={1} />
                {label(node) && <text y={s / 2 + 14 / Math.sqrt(view.k)} style={{ fontSize: 11.5 / Math.sqrt(view.k) }}>{node.name}</text>}
              </g>
            })}
          </g>
        </svg>
        <p className="graph-foot">{graph ? shown.nodes.length + ' files, ' + shown.edges.length + ' links' + (graph.truncated ? ' · first 400 files' : '') : ''}<span>Scroll to zoom · drag to move · double-click opens</span></p>
      </div>
      <aside className="graph-side">
        <section>
          <h3>Selected</h3>
          {chosen ? <>
            <p className="graph-title">{chosen.name}</p>
            <p className="help">{chosen.group === 'package' ? 'Installed package' : chosen.id + (chosen.lines ? ' · ' + chosen.lines + ' lines' : '')}</p>
            {links && <p className="graph-summary">{summary(links, graph!)}</p>}
            {chosen.group !== 'package' && <button className="text-btn primary" onClick={() => onOpen(chosen.id)}>Open file</button>}
          </> : <p className="help">Click a file to see what it imports and what uses it.</p>}
        </section>
        <section>
          <h3>Show</h3>
          <Toggle label="Tests" checked={filters.tests} onChange={tests => set({ tests })} />
          <Toggle label="Installed packages" checked={filters.packages} onChange={packages => set({ packages })} />
          <Toggle label="Data files" checked={filters.data} onChange={data => set({ data })} />
          <Toggle label="Unconnected files" checked={filters.lonely} onChange={lonely => set({ lonely })} />
        </section>
        <section>
          <h3>Display</h3>
          <div className="graph-row"><span>Labels</span><Segmented label="Labels" value={filters.labels} onChange={labels => set({ labels })} options={[{ value: 'none', label: 'None' }, { value: 'some', label: 'Some' }, { value: 'all', label: 'All' }]} /></div>
          <div className="graph-row"><span>Spacing</span><Segmented label="Spacing" value={String(filters.spacing)} onChange={value => set({ spacing: Number(value) })} options={[{ value: '0.75', label: 'Tight' }, { value: '1', label: 'Normal' }, { value: '1.4', label: 'Loose' }]} /></div>
        </section>
      </aside>
    </div>
  </div>
}

function summary(links: { imports: string[]; usedBy: string[] }, graph: Graph) {
  const name = (id: string) => graph.nodes.find(node => node.id === id)?.name ?? id
  const count = (n: number) => n + (n === 1 ? ' file' : ' files')
  const used = links.usedBy.length
    ? 'Used by ' + count(links.usedBy.length) + ', including ' + links.usedBy.slice(0, 3).map(name).join(', ') + '.'
    : 'Nothing uses it yet.'
  return (links.imports.length ? 'Imports ' + count(links.imports.length) + '. ' : 'Imports nothing from the project. ') + used
}

/** The small "Around this file" island: the active file in the middle and its neighbours around it. */
export function MiniGraph({ graph, active, onOpen, onExpand }: { graph: Graph | null; active?: string; onOpen: (path: string) => void; onExpand: () => void }) {
  const items = useMemo(() => {
    if (!graph || !active) return []
    const { imports, usedBy } = neighbours(graph, active)
    const ids = [...new Set([...imports, ...usedBy])].slice(0, 10)
    return ids.map((id, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, ids.length)) * Math.PI * 2 + (ids.length % 2 ? 0 : Math.PI / ids.length)
      const node = graph.nodes.find(item => item.id === id)!
      return { node, x: 50 + Math.cos(angle) * 34, y: 48 + Math.sin(angle) * 32, uses: imports.includes(id) }
    })
  }, [graph, active])
  const name = active?.split('/').at(-1)
  return <div className="mini-graph">
    <div className="island-head"><span>{name ? 'Around ' + name : 'Graph'}</span><button onClick={onExpand}>Open graph</button></div>
    <div className="mini-canvas">
      {!graph && <p className="help">Reading files…</p>}
      {graph && active && !items.length && <p className="help mini-empty">{name} has no imports or links yet.</p>}
      {graph && !active && <p className="help mini-empty">Open a file to see what it connects to.</p>}
      {active && items.length > 0 && <>
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          {items.map(item => <line key={item.node.id} x1="50" y1="48" x2={item.x} y2={item.y} vectorEffect="non-scaling-stroke" />)}
        </svg>
        <span className="mini-node center" style={{ left: '50%', top: '48%' }}><i /><b>{name}</b></span>
        {items.map((item, index) => <button key={item.node.id} className={'mini-node group-' + item.node.group} style={{ left: item.x + '%', top: item.y + '%', animationDelay: index * 18 + 'ms' }}
          title={(item.uses ? 'Imported by this file: ' : 'Uses this file: ') + item.node.id} disabled={item.node.group === 'package'} onClick={() => onOpen(item.node.id)}>
          <i style={{ width: size(item.node) - 2, height: size(item.node) - 2 }} /><span>{item.node.name}</span>
        </button>)}
      </>}
    </div>
  </div>
}
