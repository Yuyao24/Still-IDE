import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { type Graph, type GraphEdge, type GraphNode, type Point, neighbours } from './graph'
import { Segmented, Toggle } from './ui'

type Scope = 'all' | 'around' | 'changed'
interface Filters { tests: boolean; packages: boolean; data: boolean; lonely: boolean; labels: 'some' | 'all' | 'none'; spacing: number }

const defaultsFilters: Filters = { tests: true, packages: true, data: true, lonely: false, labels: 'some', spacing: 1 }
function storedFilters(): Filters {
  try { return { ...defaultsFilters, ...JSON.parse(localStorage.getItem('still.graph') ?? '{}') } } catch { return defaultsFilters }
}

interface Body { x: number; y: number; vx: number; vy: number; fixed: boolean }

/**
 * A live force simulation: files push apart, links pull together, and everything drifts
 * gently toward the middle. It runs while there is energy left and goes still when settled.
 */
function useSimulation(nodes: GraphNode[], edges: GraphEdge[], spacing: number) {
  const bodies = useRef(new Map<string, Body>())
  const energy = useRef(1)
  const frame = useRef(0)
  const [, setTick] = useState(0)
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const step = useCallback(() => {
    const list = nodes.map(node => [node.id, bodies.current.get(node.id)!] as const).filter(([, body]) => body)
    const index = new Map(list.map(([id], i) => [id, i]))
    const ideal = (list.length > 1 ? 520 / Math.sqrt(list.length) : 100) * spacing
    const heat = energy.current
    for (let a = 0; a < list.length; a++) {
      const one = list[a][1]
      for (let b = a + 1; b < list.length; b++) {
        const two = list[b][1]
        let dx = one.x - two.x, dy = one.y - two.y
        let distance = Math.hypot(dx, dy)
        if (distance < .01) { dx = Math.random() - .5; dy = Math.random() - .5; distance = 1 }
        if (distance > ideal * 4) continue
        const push = Math.min(40, (ideal * ideal) / (distance * distance)) * .9 * heat
        one.vx += dx / distance * push; one.vy += dy / distance * push
        two.vx -= dx / distance * push; two.vy -= dy / distance * push
      }
    }
    for (const edge of edges) {
      const a = index.get(edge.from), b = index.get(edge.to)
      if (a === undefined || b === undefined) continue
      const one = list[a][1], two = list[b][1]
      const dx = two.x - one.x, dy = two.y - one.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const pull = (distance - ideal) / distance * .07 * heat
      one.vx += dx * pull; one.vy += dy * pull
      two.vx -= dx * pull; two.vy -= dy * pull
    }
    for (const [, body] of list) {
      if (body.fixed) { body.vx = 0; body.vy = 0; continue }
      body.vx += (500 - body.x) * .006 * heat
      body.vy += (500 - body.y) * .006 * heat
      const speed = Math.hypot(body.vx, body.vy)
      if (speed > 28) { body.vx *= 28 / speed; body.vy *= 28 / speed }
      body.x += body.vx; body.y += body.vy
      body.vx *= .62; body.vy *= .62
    }
    energy.current *= .975
  }, [nodes, edges, spacing])

  const run = useCallback(() => {
    cancelAnimationFrame(frame.current)
    const loop = () => {
      step()
      setTick(value => value + 1)
      const dragging = [...bodies.current.values()].some(body => body.fixed)
      if (energy.current > .02 || dragging) frame.current = requestAnimationFrame(loop)
    }
    frame.current = requestAnimationFrame(loop)
  }, [step])

  // New or filtered nodes: keep where existing files are, start new ones near the middle.
  useEffect(() => {
    const next = new Map<string, Body>()
    const random = (() => { let seed = 7; return () => (seed = (seed * 16807) % 2147483647) / 2147483647 })()
    const fresh = !bodies.current.size
    for (const node of nodes) {
      const old = bodies.current.get(node.id)
      const neighbour = edges.find(edge => edge.from === node.id || edge.to === node.id)
      const anchor = neighbour && bodies.current.get(neighbour.from === node.id ? neighbour.to : neighbour.from)
      next.set(node.id, old ? { ...old, fixed: false } : {
        x: (anchor?.x ?? 500) + (random() - .5) * (fresh ? 120 : 40),
        y: (anchor?.y ?? 500) + (random() - .5) * (fresh ? 120 : 40),
        vx: 0, vy: 0, fixed: false,
      })
    }
    bodies.current = next
    energy.current = fresh ? 1 : Math.max(energy.current, .5)
    if (reduced) { for (let i = 0; i < 300; i++) step(); energy.current = 0; setTick(value => value + 1) }
    else run()
    return () => cancelAnimationFrame(frame.current)
  }, [nodes, edges, spacing])

  return {
    points: bodies.current as Map<string, Point>,
    hold(id: string, x: number, y: number) {
      const body = bodies.current.get(id)
      if (!body) return
      body.x = x; body.y = y; body.fixed = true
      energy.current = Math.max(energy.current, .35)
      if (!reduced) run()
    },
    release(id: string) {
      const body = bodies.current.get(id)
      if (body) body.fixed = false
      energy.current = Math.max(energy.current, .25)
      if (!reduced) run()
    },
  }
}

const size = (node: GraphNode) => Math.round(8 + Math.sqrt(node.degree) * 3)

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
  const layer = useRef<SVGGElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean; node?: string } | null>(null)
  const set = (change: Partial<Filters>) => setFilters(value => { const next = { ...value, ...change }; try { localStorage.setItem('still.graph', JSON.stringify(next)) } catch { /* ignore */ } return next })

  const shown = useMemo(() => graph ? visible(graph, filters, scope, active, changed) : { nodes: [], edges: [] }, [graph, filters, scope, active, changed])
  const simulation = useSimulation(shown.nodes, shown.edges, filters.spacing)
  const points = simulation.points
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

  /** A screen point in the SVG's own units (root) or in the zoomed layer's units. */
  function toSvg(x: number, y: number, inLayer = false) {
    const target = inLayer ? layer.current : svg.current
    const matrix = target?.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    const point = new DOMPoint(x, y).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }

  // Wheel zoom around the pointer. Attached natively so the page itself never scrolls.
  useEffect(() => {
    const node = svg.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const at = toSvg(event.clientX, event.clientY)
      setView(value => {
        const k = Math.max(.3, Math.min(6, value.k * Math.exp(-event.deltaY * .0015)))
        return { k, x: at.x - (at.x - value.x) * (k / value.k), y: at.y - (at.y - value.y) * (k / value.k) }
      })
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])

  function down(event: ReactPointerEvent) {
    const nodeElement = (event.target as Element).closest('[data-node]')
    drag.current = { x: event.clientX, y: event.clientY, moved: false, node: nodeElement?.getAttribute('data-node') ?? undefined }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }
  function move(event: ReactPointerEvent) {
    const start = drag.current
    if (!start) return
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3) start.moved = true
    if (!start.moved) return
    if (start.node) {
      const at = toSvg(event.clientX, event.clientY, true)
      simulation.hold(start.node, at.x, at.y)
      return
    }
    const from = toSvg(start.x, start.y), to = toSvg(event.clientX, event.clientY)
    start.x = event.clientX; start.y = event.clientY
    setView(value => ({ ...value, x: value.x + to.x - from.x, y: value.y + to.y - from.y }))
  }
  function up() {
    const start = drag.current
    drag.current = null
    if (!start) return
    if (start.node) {
      if (start.moved) simulation.release(start.node)
      else setSelected(start.node)
    } else if (!start.moved) setSelected(undefined)
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
        <svg ref={svg} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onDoubleClick={event => { const id = (event.target as Element).closest('[data-node]')?.getAttribute('data-node'); if (id && !id.startsWith('package:')) onOpen(id) }}>
          <g ref={layer} transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
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
              return <g key={node.id} data-node={node.id} className={classes} transform={`translate(${point.x} ${point.y})`}
                onPointerEnter={() => { if (!drag.current) setHover(node.id) }} onPointerLeave={() => { if (!drag.current) setHover(null) }}>
                <rect x={-s / 2 - 8} y={-s / 2 - 8} width={s + 16} height={s + 16} className="graph-hit" />
                <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={1} />
                {label(node) && <text y={s / 2 + 14 / Math.sqrt(view.k)} style={{ fontSize: 11.5 / Math.sqrt(view.k) }}>{node.name}</text>}
              </g>
            })}
          </g>
        </svg>
        <p className="graph-foot">{graph ? shown.nodes.length + ' files, ' + shown.edges.length + ' links' + (graph.truncated ? ' · first 400 files' : '') : ''}<span>Scroll to zoom · drag the page to move · drag a file to pull it · double-click opens · 0 resets</span></p>
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
