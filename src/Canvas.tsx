import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { type Graph, type GraphNode, layout } from './graph'
import { highlightToHtml } from './Editor'

// The canvas: every file as a card on a dotted desk, with dashed lines for imports and links.
// Cards stay where you put them (remembered per project), and you can add notes anywhere.

export interface Placed { x: number; y: number }
interface Note { id: string; x: number; y: number; text: string }
interface Saved { cards: Record<string, Placed>; notes: Note[] }
type Scope = 'all' | 'around' | 'changed'

const cardWidth = 340
const lineHeight = 17
const cardHeight = (node: GraphNode, detailed: boolean) => detailed ? 46 + Math.min(10, node.preview?.length ?? 0) * lineHeight + 18 : 46

function load(root: string): Saved {
  try {
    const value = JSON.parse(localStorage.getItem('still.canvas.' + root) ?? 'null')
    if (value && typeof value === 'object') return { cards: value.cards ?? {}, notes: Array.isArray(value.notes) ? value.notes : [] }
  } catch { /* ignore */ }
  return { cards: {}, notes: [] }
}
function store(root: string, saved: Saved) {
  try { localStorage.setItem('still.canvas.' + root, JSON.stringify(saved)) } catch { /* storage unavailable */ }
}

/** Starting positions for cards that have none yet: the force layout, spread out, then nudged so no two overlap. */
function arrange(nodes: GraphNode[], graph: Graph, saved: Record<string, Placed>) {
  const fresh = nodes.filter(node => !saved[node.id])
  const out: Record<string, Placed> = { ...saved }
  if (!fresh.length) return out
  const points = layout(nodes, graph.edges.filter(edge => nodes.some(n => n.id === edge.from) && nodes.some(n => n.id === edge.to)), 1.2)
  // Small projects sit close together; big ones get room. Overlaps are removed below.
  const spread = Math.max(.7, Math.min(5, Math.sqrt(nodes.length) * .42))
  for (const node of fresh) {
    const point = points.get(node.id) ?? { x: 500, y: 500 }
    out[node.id] = { x: point.x * spread, y: point.y * spread }
  }
  const boxes = nodes.map(node => ({ id: node.id, w: cardWidth, h: cardHeight(node, true), fixed: Boolean(saved[node.id]) }))
  for (let round = 0; round < 80; round++) {
    let moved = false
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const p = out[boxes[a].id], q = out[boxes[b].id]
        const overlapX = Math.min(p.x + boxes[a].w, q.x + boxes[b].w) - Math.max(p.x, q.x) + 48
        const overlapY = Math.min(p.y + boxes[a].h, q.y + boxes[b].h) - Math.max(p.y, q.y) + 40
        if (overlapX <= 0 || overlapY <= 0) continue
        moved = true
        const share = boxes[a].fixed ? [0, 1] : boxes[b].fixed ? [1, 0] : [.5, .5]
        if (overlapX < overlapY) {
          const sign = p.x < q.x ? -1 : 1
          p.x += sign * overlapX * share[0]; q.x -= sign * overlapX * share[1]
        } else {
          const sign = p.y < q.y ? -1 : 1
          p.y += sign * overlapY * share[0]; q.y -= sign * overlapY * share[1]
        }
      }
    }
    if (!moved) break
  }
  return out
}

function visible(graph: Graph, scope: Scope, active: string | undefined, changed: Set<string>) {
  let nodes = graph.nodes.filter(node => node.group !== 'package')
  const ids = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))
  const near = (seeds: string[]) => {
    const keep = new Set(seeds)
    for (const edge of edges) { if (seeds.includes(edge.from)) keep.add(edge.to); if (seeds.includes(edge.to)) keep.add(edge.from) }
    return keep
  }
  if (scope === 'around' && active) { const keep = near([active]); nodes = nodes.filter(node => keep.has(node.id)) }
  if (scope === 'changed') { const keep = near([...changed]); nodes = nodes.filter(node => keep.has(node.id)) }
  const shown = new Set(nodes.map(node => node.id))
  return { nodes, edges: edges.filter(edge => shown.has(edge.from) && shown.has(edge.to)) }
}

function linkPath(a: Placed, ah: number, b: Placed, bh: number) {
  const rightward = b.x > a.x + cardWidth / 2
  if (rightward) {
    const x1 = a.x + cardWidth, y1 = a.y + Math.min(40, ah / 2), x2 = b.x, y2 = b.y + Math.min(40, bh / 2)
    const bend = Math.max(60, (x2 - x1) / 2)
    return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`
  }
  const leftward = b.x + cardWidth < a.x + cardWidth / 2
  if (leftward) {
    const x1 = a.x, y1 = a.y + Math.min(40, ah / 2), x2 = b.x + cardWidth, y2 = b.y + Math.min(40, bh / 2)
    const bend = Math.max(60, (x1 - x2) / 2)
    return `M${x1} ${y1} C${x1 - bend} ${y1} ${x2 + bend} ${y2} ${x2} ${y2}`
  }
  const down = b.y > a.y
  const x1 = a.x + cardWidth / 2, y1 = down ? a.y + ah : a.y, x2 = b.x + cardWidth / 2, y2 = down ? b.y : b.y + bh
  const bend = Math.max(50, Math.abs(y2 - y1) / 2) * (down ? 1 : -1)
  return `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`
}

interface ViewProps {
  graph: Graph | null
  error?: string
  root: string
  project: string
  active?: string
  changed: Set<string>
  onOpen: (path: string) => void
  onClose: () => void
}

interface Camera { x: number; y: number; k: number }

/** One file on the desk. Memoised so moving the camera doesn't re-render every card. */
const Card = memo(function Card({ node, x, y, html, active, selected, changed, dragging }: { node: GraphNode; x: number; y: number; html: string; active: boolean; selected: boolean; changed: boolean; dragging: boolean }) {
  return <section data-card={node.id} className={['cv-card', 'group-' + node.group, active && 'is-active', selected && 'is-selected', changed && 'is-changed', dragging && 'is-dragging'].filter(Boolean).join(' ')}
    style={{ left: x, top: y, width: cardWidth }} title={node.id}>
    <header><b>{node.id}</b><span>{active ? 'open now' : changed ? 'changed' : node.lines ? node.lines + ' lines' : ''}</span></header>
    {html && <pre dangerouslySetInnerHTML={{ __html: html }} />}
  </section>
})

/** The full canvas, filling the window. */
/** The dot grid keeps an even density at any zoom, as graphing tools do with grid lines: dots on
 *  screen stay 22–44px apart, and a finer set fades in between them as you zoom in (and out as you
 *  zoom out), so changing level never pops. */
function dotGrid(camera: { x: number; y: number; k: number }) {
  let spacing = 22 * camera.k
  while (spacing < 22) spacing *= 2
  while (spacing >= 44) spacing /= 2
  const fine = Math.max(0, Math.min(1, (spacing - 22) / 22))
  const dot = (alpha: number) => `radial-gradient(color-mix(in srgb, var(--muted) ${alpha.toFixed(1)}%, transparent) 1px, transparent 1.2px)`
  const position = `${camera.x}px ${camera.y}px`
  return {
    backgroundImage: `${dot(34)}, ${dot(34 * fine * fine)}`,
    backgroundSize: `${spacing}px ${spacing}px, ${spacing / 2}px ${spacing / 2}px`,
    backgroundPosition: `${position}, ${position}`,
  }
}

export function CanvasView({ graph, error, root, project, active, changed, onOpen, onClose }: ViewProps) {
  const [scope, setScope] = useState<Scope>('all')
  const [saved, setSaved] = useState(() => load(root))
  // One camera drives everything (cards, links, the dot grid and the minimap), so they always move together.
  const [camera, setCameraNow] = useState<Camera>({ x: 0, y: 0, k: .8 })
  const [selected, setSelected] = useState<string | null>(active ?? null)
  const shownCamera = useRef(camera)
  shownCamera.current = camera
  const motion = useRef<{ raf: number; tween?: { from: Camera; to: Camera; start: number; ms: number }; zoom?: { k: number; px: number; py: number; wx: number; wy: number } }>({ raf: 0 })
  const stop = () => { cancelAnimationFrame(motion.current.raf); motion.current = { raf: 0 } }
  const frameStep = useCallback((time: number) => {
    const state = motion.current, box = desk.current
    const current = shownCamera.current
    let next: Camera | null = null, done = true
    if (state.tween && box) {
      // Fly: the point at the centre of the screen moves in a straight line while the zoom changes evenly.
      const { from, to, start, ms } = state.tween
      const t = Math.min(1, (time - start) / ms), e = 1 - Math.pow(1 - t, 3)
      const cx = box.clientWidth / 2, cy = box.clientHeight / 2
      const k = from.k * Math.pow(to.k / from.k, e)
      const wx = (cx - from.x) / from.k + ((cx - to.x) / to.k - (cx - from.x) / from.k) * e
      const wy = (cy - from.y) / from.k + ((cy - to.y) / to.k - (cy - from.y) / from.k) * e
      next = { k, x: cx - wx * k, y: cy - wy * k }
      done = t >= 1
    } else if (state.zoom) {
      // Wheel zoom eases toward its target and keeps the point under the pointer still.
      const { k: goal, px, py, wx, wy } = state.zoom
      const k = Math.abs(goal - current.k) < goal * .002 ? goal : current.k + (goal - current.k) * .3
      next = { k, x: px - wx * k, y: py - wy * k }
      done = k === goal
    }
    if (next) { shownCamera.current = next; setCameraNow(next) }
    if (done) motion.current = { raf: 0 }
    else motion.current.raf = requestAnimationFrame(frameStep)
  }, [])
  const setCamera = useCallback((next: Camera | ((value: Camera) => Camera), smooth = false) => {
    const value = typeof next === 'function' ? next(shownCamera.current) : next
    stop()
    if (!smooth) { shownCamera.current = value; setCameraNow(value); return }
    motion.current = { raf: requestAnimationFrame(frameStep), tween: { from: shownCamera.current, to: value, start: performance.now(), ms: 360 } }
  }, [frameStep])
  useEffect(() => () => cancelAnimationFrame(motion.current.raf), [])
  const desk = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: 'pan' | 'card' | 'note'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const fitted = useRef(false)

  const shown = useMemo(() => graph ? visible(graph, scope, active, changed) : { nodes: [], edges: [] }, [graph, scope, active, changed])
  const positions = useMemo(() => graph ? arrange(shown.nodes, graph, saved.cards) : {}, [shown, graph])
  const [live, setLive] = useState<Record<string, Placed>>({})
  useEffect(() => { setLive(positions) }, [positions])
  // Cards keep one size at every zoom (the code just fades when far away), so nothing jumps while zooming.
  const far = camera.k < .42
  const heights = useMemo(() => Object.fromEntries(shown.nodes.map(node => [node.id, cardHeight(node, true)])), [shown])
  const previews = useMemo(() => Object.fromEntries(shown.nodes.map(node => [node.id, node.preview ? highlightToHtml(node.preview.join('\n'), node.name.split('.').at(-1) ?? '') : ''])), [shown])

  const persist = useCallback((cards: Record<string, Placed>, notes: Note[]) => {
    const next = { cards: { ...saved.cards, ...cards }, notes }
    setSaved(next); store(root, next)
  }, [saved, root])

  const fit = useCallback((smooth: boolean) => {
    const box = desk.current
    const items = [...shown.nodes.map(node => ({ ...(live[node.id] ?? positions[node.id]), w: cardWidth, h: heights[node.id] ?? 120 })), ...saved.notes.map(note => ({ x: note.x, y: note.y, w: 220, h: 120 }))].filter(item => item.x !== undefined)
    if (!box || !items.length) return
    const minX = Math.min(...items.map(item => item.x)), minY = Math.min(...items.map(item => item.y))
    const maxX = Math.max(...items.map(item => item.x + item.w)), maxY = Math.max(...items.map(item => item.y + item.h))
    const k = Math.max(.15, Math.min(1, (box.clientWidth - 120) / (maxX - minX), (box.clientHeight - 120) / (maxY - minY)))
    setCamera({ k, x: (box.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (box.clientHeight - (maxY - minY) * k) / 2 - minY * k }, smooth)
  }, [shown, live, positions, heights, saved.notes, setCamera])

  const focusOn = useCallback((id: string, smooth = true) => {
    const box = desk.current, at = live[id] ?? positions[id]
    if (!box || !at) return
    const k = Math.max(shownCamera.current.k, .7)
    setCamera({ k, x: box.clientWidth / 2 - (at.x + cardWidth / 2) * k, y: box.clientHeight / 2 - (at.y + 120) * k }, smooth)
  }, [live, positions, setCamera])

  useEffect(() => {
    if (fitted.current || !graph || !Object.keys(live).length) return
    fitted.current = true
    if (active && live[active] && shown.nodes.length > 12) focusOn(active, false)
    else fit(false)
  }, [graph, live])

  useEffect(() => { if (fitted.current) fit(true) }, [scope])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest?.('textarea')) return
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Enter' && selected && !selected.startsWith('note:')) onOpen(selected)
      if (event.key === '0') fit(true)
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [selected, fit, onClose, onOpen])

  useEffect(() => {
    const node = desk.current
    if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = node.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top
      const current = shownCamera.current
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send bigger steps.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      const goal = Math.max(.15, Math.min(2.2, (motion.current.zoom?.k ?? current.k) * Math.exp(-delta * (event.ctrlKey ? .01 : .0018))))
      const zoom = { k: goal, px, py, wx: (px - current.x) / current.k, wy: (py - current.y) / current.k }
      const running = motion.current.raf && motion.current.zoom
      motion.current = { raf: running ? motion.current.raf : 0, zoom }
      if (!running) { cancelAnimationFrame(motion.current.raf); motion.current.raf = requestAnimationFrame(frameStep) }
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [frameStep])

  function down(event: ReactPointerEvent) {
    const target = event.target as Element
    if (target.closest('textarea, button, .cv-float, .cv-map')) return
    const card = target.closest<HTMLElement>('[data-card]'), note = target.closest<HTMLElement>('[data-note]')
    stop()
    if (card) {
      const id = card.dataset.card!, at = live[id]
      drag.current = { kind: 'card', id, sx: event.clientX, sy: event.clientY, ox: at.x, oy: at.y, moved: false }
      setSelected(id)
    } else if (note) {
      const id = note.dataset.note!, at = saved.notes.find(item => item.id === id)!
      drag.current = { kind: 'note', id, sx: event.clientX, sy: event.clientY, ox: at.x, oy: at.y, moved: false }
    } else {
      drag.current = { kind: 'pan', sx: event.clientX, sy: event.clientY, ox: camera.x, oy: camera.y, moved: false }
    }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }
  function move(event: ReactPointerEvent) {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.sx, dy = event.clientY - state.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true
    if (!state.moved) return
    if (state.kind === 'pan') setCamera(value => ({ ...value, x: state.ox + dx, y: state.oy + dy }))
    else if (state.kind === 'card') setLive(value => ({ ...value, [state.id!]: { x: state.ox + dx / camera.k, y: state.oy + dy / camera.k } }))
    else setSaved(value => ({ ...value, notes: value.notes.map(item => item.id === state.id ? { ...item, x: state.ox + dx / camera.k, y: state.oy + dy / camera.k } : item) }))
  }
  function up() {
    const state = drag.current
    drag.current = null
    if (!state) return
    if (state.kind === 'pan' && !state.moved) setSelected(null)
    if (state.kind === 'card' && state.moved) persist({ [state.id!]: live[state.id!] }, saved.notes)
    if (state.kind === 'note' && state.moved) persist({}, saved.notes)
  }
  function addNote() {
    const box = desk.current!
    const note: Note = { id: 'n' + Date.now().toString(36), text: '', x: (box.clientWidth / 2 - camera.x) / camera.k - 110, y: (box.clientHeight / 2 - camera.y) / camera.k - 60 }
    persist({}, [...saved.notes, note])
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-note="${note.id}"] textarea`)?.focus())
  }

  const lit = (from: string, to: string) => selected === from || selected === to
  const world = `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})`

  // Minimap
  const mapItems = shown.nodes.map(node => ({ id: node.id, ...(live[node.id] ?? { x: 0, y: 0 }), w: cardWidth, h: heights[node.id] ?? 100 }))
  const mapBounds = mapItems.length ? {
    minX: Math.min(...mapItems.map(item => item.x)) - 200, minY: Math.min(...mapItems.map(item => item.y)) - 200,
    maxX: Math.max(...mapItems.map(item => item.x + item.w)) + 200, maxY: Math.max(...mapItems.map(item => item.y + item.h)) + 200,
  } : null
  const mapScale = mapBounds ? Math.min(176 / (mapBounds.maxX - mapBounds.minX), 108 / (mapBounds.maxY - mapBounds.minY)) : 1

  return <div className="graph-view canvas-view" role="dialog" aria-label="Project canvas">
    <header className="graph-head">
      <span className="graph-crumbs"><b>Still</b><i>/</i>{project}<i>/</i>Canvas</span>
      <nav className="under-tabs" aria-label="What the canvas shows">
        {([['all', 'Whole project'], ['around', 'Around this file'], ['changed', 'Changed files']] as [Scope, string][]).map(([value, text]) =>
          <button key={value} className={scope === value ? 'is-active' : ''} aria-pressed={scope === value} onClick={() => setScope(value)} disabled={value === 'around' && !active}>{text}</button>)}
      </nav>
      <button className="quiet-link" onClick={onClose}>Esc to return</button>
    </header>
    <div ref={desk} className="cv-desk" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={event => { const id = (event.target as Element).closest<HTMLElement>('[data-card]')?.dataset.card; if (id) onOpen(id) }}
      style={dotGrid(camera)}>
      {!graph && <p className="graph-note">{error || 'Laying out your files…'}</p>}
      {graph && !shown.nodes.length && <p className="graph-note">{scope === 'changed' ? 'No changed files.' : 'No files to show yet.'}</p>}
      <div className={'cv-world' + (far ? ' is-far' : '')} style={{ transform: world }}>
        <svg className="cv-links" aria-hidden="true">
          {shown.edges.map(edge => {
            const a = live[edge.from], b = live[edge.to]
            if (!a || !b) return null
            return <path key={edge.from + edge.to} d={linkPath(a, heights[edge.from], b, heights[edge.to])} className={lit(edge.from, edge.to) ? 'lit' : ''} />
          })}
        </svg>
        {shown.nodes.map(node => {
          const at = live[node.id]
          if (!at) return null
          return <Card key={node.id} node={node} x={at.x} y={at.y} html={previews[node.id]} active={node.id === active} selected={node.id === selected}
            changed={changed.has(node.id)} dragging={drag.current?.id === node.id && drag.current.moved} />
        })}
        {saved.notes.map(note => <section key={note.id} data-note={note.id} className="cv-note" style={{ left: note.x, top: note.y }}>
          <header><b>Note</b><button aria-label="Delete note" onClick={() => persist({}, saved.notes.filter(item => item.id !== note.id))}>Delete</button></header>
          <textarea aria-label="Note text" value={note.text} placeholder="Write a note…" onChange={event => setSaved(value => ({ ...value, notes: value.notes.map(item => item.id === note.id ? { ...item, text: event.target.value } : item) }))}
            onBlur={() => store(root, saved)} />
        </section>)}
      </div>
      <div className="cv-float">
        <button onClick={addNote}>Add note</button>
        <button onClick={() => fit(true)}>Fit all</button>
        {active && <button onClick={() => focusOn(active)}>Go to open file</button>}
        <span className="cv-zoom">{Math.round(camera.k * 100)}%</span>
      </div>
      {mapBounds && <div className="cv-map" aria-hidden="true" onClick={event => {
        const box = event.currentTarget.getBoundingClientRect(), deskBox = desk.current!
        const wx = (event.clientX - box.left - 6) / mapScale + mapBounds.minX, wy = (event.clientY - box.top - 6) / mapScale + mapBounds.minY
        setCamera(value => ({ ...value, x: deskBox.clientWidth / 2 - wx * value.k, y: deskBox.clientHeight / 2 - wy * value.k }), true)
      }}>
        {mapItems.map(item => <i key={item.id} className={item.id === active ? 'on' : ''} style={{ left: 6 + (item.x - mapBounds.minX) * mapScale, top: 6 + (item.y - mapBounds.minY) * mapScale, width: item.w * mapScale, height: item.h * mapScale }} />)}
        {desk.current && <span style={{ left: 6 + (-camera.x / camera.k - mapBounds.minX) * mapScale, top: 6 + (-camera.y / camera.k - mapBounds.minY) * mapScale, width: desk.current.clientWidth / camera.k * mapScale, height: desk.current.clientHeight / camera.k * mapScale }} />}
      </div>}
      <p className="cv-hint">Drag cards to arrange · scroll to zoom · double-click a card to open it · 0 fits all</p>
    </div>
  </div>
}

/** The small canvas island: the open file and the files it touches, as a little desk. */
export function MiniCanvas({ graph, root, active, onOpen, onExpand }: { graph: Graph | null; root: string; active?: string; onOpen: (path: string) => void; onExpand: () => void }) {
  const items = useMemo(() => {
    if (!graph || !active) return null
    const ids = new Set([active])
    for (const edge of graph.edges) {
      if (edge.from === active && !edge.to.startsWith('package:')) ids.add(edge.to)
      if (edge.to === active) ids.add(edge.from)
    }
    const nodes = graph.nodes.filter(node => ids.has(node.id)).slice(0, 9)
    const saved = load(root).cards
    const placed = arrange(graph.nodes.filter(node => node.group !== 'package'), graph, saved)
    const boxes = nodes.map(node => ({ node, ...placed[node.id], h: cardHeight(node, false) + 10 }))
    const minX = Math.min(...boxes.map(box => box.x)), minY = Math.min(...boxes.map(box => box.y))
    const maxX = Math.max(...boxes.map(box => box.x + cardWidth)), maxY = Math.max(...boxes.map(box => box.y + box.h))
    return { boxes, minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }, [graph, active, root])
  const name = active?.split('/').at(-1)
  const sx = (x: number) => items ? 6 + ((x - items.minX) / items.w) * 88 : 0
  const sy = (y: number) => items ? 6 + ((y - items.minY) / items.h) * 82 : 0
  return <div className="mini-graph">
    <div className="island-head"><span>{name ? 'Canvas · around ' + name : 'Canvas'}</span><button onClick={onExpand}>Open canvas</button></div>
    <div className="mini-desk" onClick={event => { if (!(event.target as Element).closest('button')) onExpand() }} role="presentation">
      {!graph && <p className="help mini-empty">Laying out your files…</p>}
      {graph && !active && <p className="help mini-empty">Open a file to see the files around it.</p>}
      {items && items.boxes.length === 1 && <p className="help mini-empty">{name} doesn't import or link to other files yet.</p>}
      {items && items.boxes.length > 1 && <>
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          {graph!.edges.filter(edge => items.boxes.some(box => box.node.id === edge.from) && items.boxes.some(box => box.node.id === edge.to)).map(edge => {
            const a = items.boxes.find(box => box.node.id === edge.from)!, b = items.boxes.find(box => box.node.id === edge.to)!
            return <line key={edge.from + edge.to} x1={sx(a.x + cardWidth / 2)} y1={sy(a.y) + 3} x2={sx(b.x + cardWidth / 2)} y2={sy(b.y) + 3} vectorEffect="non-scaling-stroke" />
          })}
        </svg>
        {items.boxes.map((box, index) => <button key={box.node.id} className={'mini-card' + (box.node.id === active ? ' on' : '')} title={box.node.id}
          style={{ left: sx(box.x) + '%', top: sy(box.y) + '%', width: Math.max(18, (cardWidth / items.w) * 88) + '%', animationDelay: index * 20 + 'ms' }}
          onClick={() => onOpen(box.node.id)}>{box.node.name}</button>)}
      </>}
    </div>
  </div>
}
