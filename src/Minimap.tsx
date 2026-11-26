// A small picture of the whole file, each word a coloured stroke, with a box for the part on
// screen. Click or drag to move through the file.
import { useEffect, useMemo, useRef, useState } from 'react'
import { minimapTokens } from './Editor'

const colorVars: Record<string, string> = { keyword: '--keyword', string: '--string', number: '--number', type: '--type', function: '--function', variable: '--variable', comment: '--comment', property: '--property', operator: '--operator', tag: '--tag', attribute: '--attribute' }

export function Minimap({ path, text, viewport, onScroll }: {
  path: string | null; text: string
  viewport: { top: number; height: number; lines: number } | null
  onScroll: (fraction: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 240, height: 600 })
  // Recolouring waits for typing to pause.
  const [settled, setSettled] = useState(text)
  useEffect(() => { const timer = setTimeout(() => setSettled(text), 250); return () => clearTimeout(timer) }, [text])
  const runs = useMemo(() => path ? minimapTokens(settled, path) : [], [settled, path])
  const lines = Math.max(1, settled.split('\n').length)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Lines are up to 4px tall (a stroke and a gap) when the file fits; longer files are squeezed to fit.
  const lineHeight = Math.max(0.5, Math.min(4, (size.height - 16) / lines))
  const charWidth = Math.max(0.6, Math.min(2.2, (size.width - 24) / 100))
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    const ratio = window.devicePixelRatio || 1
    target.width = Math.floor(size.width * ratio)
    target.height = Math.floor(size.height * ratio)
    const context = target.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const styles = getComputedStyle(document.documentElement)
    const plain = styles.getPropertyValue('--ink').trim() || '#888'
    const palette = new Map<string, string>()
    const colorOf = (cls: string) => {
      if (!palette.has(cls)) palette.set(cls, (colorVars[cls] ? styles.getPropertyValue(colorVars[cls]).trim() : '') || plain)
      return palette.get(cls)!
    }
    context.globalAlpha = 0.72
    const stroke = Math.max(0.5, lineHeight * 0.66)
    for (const [line, from, to, cls] of runs) {
      const x = 12 + Math.min(from, 140) * charWidth
      if (x > size.width - 8) continue
      context.fillStyle = colorOf(cls)
      context.fillRect(x, 8 + line * lineHeight, Math.max(0.6, Math.min(to - from, 140 - from) * charWidth), stroke)
    }
  }, [runs, size, lineHeight, charWidth])

  const total = lines * lineHeight
  const box = viewport ? { top: 8 + viewport.top * total, height: Math.max(12, viewport.height * total) } : null
  function seek(clientY: number) {
    const element = host.current
    if (!element || !viewport) return
    const y = clientY - element.getBoundingClientRect().top - 8
    const fraction = Math.max(0, Math.min(1, (y - (box?.height ?? 0) / 2) / Math.max(1, total - (box?.height ?? 0))))
    onScroll(fraction)
  }
  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    seek(event.clientY)
    const target = event.currentTarget
    const move = (next: PointerEvent) => seek(next.clientY)
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up) }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  return <div className="minimap" ref={host} onPointerDown={down} title="Click or drag to move through the file">
    {!path ? <p className="minimap-empty">Open a file to see its outline here.</p> : <>
      <canvas ref={canvas} style={{ width: size.width, height: size.height }} />
      {box && <div className="minimap-view" style={{ top: box.top, height: box.height }} />}
    </>}
  </div>
}
