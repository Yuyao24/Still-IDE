// Editor panes: any number, side by side or stacked, laid out as a tree of rows and columns.
// Tabs are dropped on a pane's edge to split it, on a corner to take a quarter (as when
// snapping windows), or in the middle to show the file there.
import { Fragment, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

export type PaneLayout = { kind: 'pane'; id: string } | { kind: 'split'; dir: 'row' | 'column'; children: PaneLayout[]; sizes: number[] }
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const singlePane = (id: string): PaneLayout => ({ kind: 'pane', id })

export function paneIds(layout: PaneLayout): string[] {
  return layout.kind === 'pane' ? [layout.id] : layout.children.flatMap(paneIds)
}

function replace(layout: PaneLayout, id: string, make: (pane: PaneLayout) => PaneLayout): PaneLayout {
  if (layout.kind === 'pane') return layout.id === id ? make(layout) : layout
  return normalize({ ...layout, children: layout.children.map(child => replace(child, id, make)) })
}

/** Splits that hold one child are dropped, and a split inside a split of the same direction is merged into it. */
function normalize(layout: PaneLayout): PaneLayout {
  if (layout.kind === 'pane') return layout
  const children: PaneLayout[] = []
  const sizes: number[] = []
  layout.children.forEach((child, index) => {
    const share = layout.sizes[index] ?? 1 / layout.children.length
    if (child.kind === 'split' && child.dir === layout.dir) child.children.forEach((inner, at) => { children.push(inner); sizes.push(share * (child.sizes[at] ?? 1 / child.children.length)) })
    else { children.push(child); sizes.push(share) }
  })
  if (children.length === 1) return children[0]
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1
  return { ...layout, children, sizes: sizes.map(size => size / total) }
}

function parentOf(layout: PaneLayout, id: string): { parent: Extract<PaneLayout, { kind: 'split' }>; index: number } | null {
  if (layout.kind === 'pane') return null
  const index = layout.children.findIndex(child => child.kind === 'pane' && child.id === id)
  if (index >= 0) return { parent: layout, index }
  for (const child of layout.children) { const found = parentOf(child, id); if (found) return found }
  return null
}

/** Puts a new pane next to `target`. A corner takes a quarter: when the pane is already half
 *  of the area on that side it is simply halved again; otherwise an empty pane fills the rest. */
export function splitPane(layout: PaneLayout, target: string, zone: Exclude<DropZone, 'center'>, newId: string, emptyId: string): { layout: PaneLayout; empty: string | null } {
  if (zone.includes('-')) {
    const vertical = zone.startsWith('top') ? 'top' : 'bottom'
    const horizontal = zone.endsWith('left') ? 'left' : 'right'
    const found = parentOf(layout, target)
    if (found) {
      const last = found.index === found.parent.children.length - 1, first = found.index === 0
      if (found.parent.dir === 'row' && (horizontal === 'right' ? last : first)) return splitPane(layout, target, vertical, newId, emptyId)
      if (found.parent.dir === 'column' && (vertical === 'bottom' ? last : first)) return splitPane(layout, target, horizontal, newId, emptyId)
    }
  }
  const fresh = singlePane(newId)
  let empty: string | null = null
  const next = replace(layout, target, pane => {
    switch (zone) {
      case 'left': return { kind: 'split', dir: 'row', children: [fresh, pane], sizes: [0.5, 0.5] }
      case 'right': return { kind: 'split', dir: 'row', children: [pane, fresh], sizes: [0.5, 0.5] }
      case 'top': return { kind: 'split', dir: 'column', children: [fresh, pane], sizes: [0.5, 0.5] }
      case 'bottom': return { kind: 'split', dir: 'column', children: [pane, fresh], sizes: [0.5, 0.5] }
      default: {
        empty = emptyId
        const top = zone.startsWith('top')
        const column: PaneLayout = { kind: 'split', dir: 'column', children: top ? [fresh, singlePane(emptyId)] : [singlePane(emptyId), fresh], sizes: [0.5, 0.5] }
        return { kind: 'split', dir: 'row', children: zone.endsWith('left') ? [column, pane] : [pane, column], sizes: [0.5, 0.5] }
      }
    }
  })
  return { layout: next, empty }
}

export function removePane(layout: PaneLayout, id: string): PaneLayout | null {
  if (layout.kind === 'pane') return layout.id === id ? null : layout
  const children: PaneLayout[] = []
  const sizes: number[] = []
  layout.children.forEach((child, index) => {
    const kept = removePane(child, id)
    if (kept) { children.push(kept); sizes.push(layout.sizes[index] ?? 0) }
  })
  if (!children.length) return null
  return normalize({ ...layout, children, sizes })
}

function setSizes(layout: PaneLayout, path: number[], sizes: number[]): PaneLayout {
  if (layout.kind === 'pane') return layout
  if (!path.length) return { ...layout, sizes }
  return { ...layout, children: layout.children.map((child, index) => index === path[0] ? setSizes(child, path.slice(1), sizes) : child) }
}

/** Where on a pane a dragged tab would land, from the pointer's place in its box. */
export function zoneAt(box: DOMRect, x: number, y: number): DropZone {
  const fx = (x - box.left) / box.width
  const fy = (y - box.top) / box.height
  const edgeX = Math.min(0.28, 120 / box.width)
  const edgeY = Math.min(0.28, 120 / box.height)
  const left = fx < edgeX, right = fx > 1 - edgeX, top = fy < edgeY, bottom = fy > 1 - edgeY
  // Corners are a smaller target than edges, as with window snapping.
  const cornerX = edgeX * 0.7, cornerY = edgeY * 0.7
  if (fx < cornerX && fy < cornerY) return 'top-left'
  if (fx > 1 - cornerX && fy < cornerY) return 'top-right'
  if (fx < cornerX && fy > 1 - cornerY) return 'bottom-left'
  if (fx > 1 - cornerX && fy > 1 - cornerY) return 'bottom-right'
  if (left) return 'left'
  if (right) return 'right'
  if (top) return 'top'
  if (bottom) return 'bottom'
  return 'center'
}

/** The part of the pane the file would take, for the drop preview. */
export function zoneBox(zone: DropZone): { left: string; top: string; width: string; height: string } {
  const half = '50%', full = '100%', none = '0%'
  switch (zone) {
    case 'left': return { left: none, top: none, width: half, height: full }
    case 'right': return { left: half, top: none, width: half, height: full }
    case 'top': return { left: none, top: none, width: full, height: half }
    case 'bottom': return { left: none, top: half, width: full, height: half }
    case 'top-left': return { left: none, top: none, width: half, height: half }
    case 'top-right': return { left: half, top: none, width: half, height: half }
    case 'bottom-left': return { left: none, top: half, width: half, height: half }
    case 'bottom-right': return { left: half, top: half, width: half, height: half }
    default: return { left: none, top: none, width: full, height: full }
  }
}

export function PaneGrid({ layout, renderPane, onLayout, onResizing }: {
  layout: PaneLayout
  renderPane: (id: string) => ReactNode
  onLayout: (layout: PaneLayout) => void
  onResizing?: (active: boolean) => void
}) {
  return <div className="pane-grid"><Node node={layout} path={[]} root={layout} renderPane={renderPane} onLayout={onLayout} onResizing={onResizing} /></div>
}

function Node({ node, path, root, renderPane, onLayout, onResizing }: {
  node: PaneLayout; path: number[]; root: PaneLayout
  renderPane: (id: string) => ReactNode; onLayout: (layout: PaneLayout) => void; onResizing?: (active: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  if (node.kind === 'pane') return <>{renderPane(node.id)}</>
  const row = node.dir === 'row'
  function drag(index: number, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || node.kind !== 'split') return
    event.preventDefault()
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)
    onResizing?.(true)
    const start = node.sizes.slice()
    const move = (next: PointerEvent) => {
      const rect = box.current?.getBoundingClientRect()
      if (!rect) return
      const total = row ? rect.width : rect.height
      const before = start.slice(0, index).reduce((sum, size) => sum + size, 0)
      const pair = start[index] + start[index + 1]
      const at = ((row ? next.clientX - rect.left : next.clientY - rect.top) / total) - before
      const min = Math.min(pair / 2, 140 / total)
      const first = Math.max(min, Math.min(pair - min, at))
      const sizes = start.slice()
      sizes[index] = first
      sizes[index + 1] = pair - first
      onLayout(setSizes(root, path, sizes))
    }
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); onResizing?.(false) }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }
  function even(index: number) {
    if (node.kind !== 'split') return
    const sizes = node.sizes.slice()
    const pair = sizes[index] + sizes[index + 1]
    sizes[index] = sizes[index + 1] = pair / 2
    onLayout(setSizes(root, path, sizes))
  }
  return <div ref={box} className={'pane-split is-' + node.dir}>
    {node.children.map((child, index) => <Fragment key={child.kind === 'pane' ? child.id : 'split-' + paneIds(child).join('-')}>
      {index > 0 && <div className="pane-grip" role="separator" aria-orientation={row ? 'vertical' : 'horizontal'} aria-label="Resize panes"
        onPointerDown={event => drag(index - 1, event)} onDoubleClick={() => even(index - 1)} />}
      <div className="pane-cell" style={{ flexGrow: node.sizes[index] ?? 1, flexBasis: 0 }}>
        <Node node={child} path={[...path, index]} root={root} renderPane={renderPane} onLayout={onLayout} onResizing={onResizing} />
      </div>
    </Fragment>)}
  </div>
}
