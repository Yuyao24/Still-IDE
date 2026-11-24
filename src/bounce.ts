// Elastic overscroll: scrolling past the top or bottom of a list, the editor or a
// settings page stretches the content a little and lets it spring back, the way
// macOS and phones do. Web views on Windows and Linux stop dead without this.

interface Stretch { offset: number; raw: number; timer: number; children: HTMLElement[] }
const stretches = new WeakMap<HTMLElement, Stretch>()
const limit = 64

function scrollerFor(start: Element | null): HTMLElement | null {
  for (let node = start; node && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    // The canvas pans with the wheel, and the terminal keeps its own scrollback.
    if (node.matches('.cv-desk, .xterm, .mini-desk, [data-no-bounce]')) return null
    if (node.scrollHeight <= node.clientHeight + 1) continue
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

function paint(stretch: Stretch) {
  for (const child of stretch.children) child.style.transform = stretch.offset ? `translateY(${stretch.offset}px)` : ''
}

function release(scroller: HTMLElement) {
  const stretch = stretches.get(scroller)
  if (!stretch) return
  stretches.delete(scroller)
  const from = stretch.offset
  for (const child of stretch.children) {
    child.style.transform = ''
    child.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], { duration: 420, easing: 'cubic-bezier(.2, .9, .25, 1)' })
  }
}

function wheel(event: WheelEvent) {
  const root = document.documentElement.classList
  if (root.contains('no-bounce') || root.contains('reduce-motion') || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  const scroller = scrollerFor(event.target as Element)
  if (!scroller) return
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
  const atTop = scroller.scrollTop <= 0 && delta < 0
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 && delta > 0
  let stretch = stretches.get(scroller)
  if (!atTop && !atBottom) {
    if (stretch) release(scroller)
    return
  }
  if (!stretch) {
    // Only move children that aren't already transformed by something else.
    const children = [...scroller.children].filter((child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).transform === 'none' && getComputedStyle(child).position !== 'fixed')
    if (!children.length) return
    for (const child of children) child.getAnimations().forEach(animation => animation.cancel())
    stretch = { offset: 0, raw: 0, timer: 0, children }
    stretches.set(scroller, stretch)
  }
  // Rubber band: the further you pull, the less it moves.
  stretch.raw = Math.max(-limit * 4, Math.min(limit * 4, stretch.raw - delta * .5))
  stretch.offset = Math.sign(stretch.raw) * limit * (1 - Math.exp(-Math.abs(stretch.raw) / limit))
  paint(stretch)
  clearTimeout(stretch.timer)
  stretch.timer = window.setTimeout(() => release(scroller), 110)
}

let installed = false
export function installBounce() {
  if (installed) return
  installed = true
  addEventListener('wheel', wheel, { passive: true, capture: true })
}
