import { useEffect, useRef, type ReactNode } from 'react'

export interface OverviewCard { key: string; title: string; note?: string; wide?: boolean; hidden?: boolean; current?: boolean; body: ReactNode }
export interface OverviewSpace { id: string; label: string; kind: 'home' | 'project' | 'server'; current?: boolean; preview?: string[] }
export interface OverviewLayout { id: string; label: string }

interface Props {
  title: string
  cards: OverviewCard[]
  spaces: OverviewSpace[]
  layouts: OverviewLayout[]
  layout: string | null
  onJump: (key: string) => void
  onToggle: (key: string) => void
  onSpace: (id: string) => void
  onNewSpace: () => void
  onLayout: (id: string) => void
  onSaveLayout: () => void
  onClose: () => void
}

/** Everything in the workspace at once, like a desk seen from above. */
export function Overview(props: Props) {
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const current = grid.current?.querySelector<HTMLButtonElement>('.ov-card.is-current') ?? grid.current?.querySelector<HTMLButtonElement>('.ov-card')
    current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop, .menu')) return
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'ArrowDown')) { event.preventDefault(); event.stopPropagation(); props.onClose() }
    }
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [props.onClose])

  function move(event: React.KeyboardEvent, key: string) {
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); props.onToggle(key); return }
    const direction = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key]
    if (!direction || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    // Move to the nearest card in that direction, by position on screen.
    const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const centre = (box: DOMRect) => [box.left + box.width / 2, box.top + box.height / 2]
    const [fx, fy] = centre(from)
    let best: HTMLButtonElement | null = null, score = Infinity
    for (const card of grid.current?.querySelectorAll<HTMLButtonElement>('.ov-card') ?? []) {
      if (card === event.currentTarget) continue
      const [x, y] = centre(card.getBoundingClientRect())
      const along = (x - fx) * direction[0] + (y - fy) * direction[1]
      if (along <= 1) continue
      const across = Math.abs((x - fx) * direction[1]) + Math.abs((y - fy) * direction[0])
      if (along + across * 2 < score) { score = along + across * 2; best = card }
    }
    best?.focus()
  }

  return <div className="overview" role="dialog" aria-label="Overview">
    <nav className="ov-spaces" aria-label="Workspaces">
      {props.spaces.map((space, index) => <button key={space.id} className={'ov-space' + (space.current ? ' is-current' : '')} style={{ animationDelay: index * 20 + 'ms' }}
        aria-current={space.current ? 'page' : undefined} onClick={() => space.current ? props.onClose() : props.onSpace(space.id)}>
        <span className={'ov-thumb kind-' + space.kind}>
          {space.kind === 'home' && <><i /><i /><i /></>}
          {space.kind === 'project' && <><i /><i /></>}
          {space.kind === 'server' && (space.preview ?? ['$ ssh ' + space.label]).map(line => <span key={line}>{line}</span>)}
        </span>
        <span className="ov-space-name">{space.label}</span>
      </button>)}
      <button className="ov-new" aria-label="Open another folder" title="Open another folder" onClick={props.onNewSpace}>+</button>
    </nav>

    <div className="ov-title">
      <h1>{props.title}</h1>
      <span>Click or Enter to jump · Delete hides or shows · Esc returns</span>
    </div>

    <div className="ov-grid" ref={grid}>
      {props.cards.map((card, index) => <button key={card.key} className={'ov-card' + (card.wide ? ' wide' : '') + (card.hidden ? ' is-hidden' : '') + (card.current ? ' is-current' : '')}
        style={{ animationDelay: 40 + index * 22 + 'ms' }} onClick={() => props.onJump(card.key)} onKeyDown={event => move(event, card.key)}
        aria-label={card.title + (card.hidden ? ', hidden' : '')}>
        <span className="ov-card-head"><b>{card.title}</b><span>{card.hidden ? 'hidden' : card.note}</span></span>
        <span className="ov-card-body">{card.body}</span>
      </button>)}
    </div>

    <nav className="ov-layouts" aria-label="Layouts">
      <span className="ov-layouts-label">Layouts</span>
      {props.layouts.map(item => <button key={item.id} className={props.layout === item.id ? 'is-active' : ''} aria-pressed={props.layout === item.id} onClick={() => props.onLayout(item.id)}>{item.label}</button>)}
      <span className="ov-rule" />
      <button onClick={props.onSaveLayout}>Save current</button>
    </nav>
  </div>
}
