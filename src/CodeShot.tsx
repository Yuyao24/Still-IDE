import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { Copy, Download } from 'lucide-react'
import { desktop, fileName } from './bridge'
import type { CodeCapture, TokenKind } from './Editor'
import { useSettings } from './settings'
import { resolve } from './themes'
import { Icon, Modal, Segmented, Toggle } from './ui'

type Background = 'paper' | 'stone' | 'ink' | 'theme' | 'none'
const backgrounds: { value: Background; label: string }[] = [
  { value: 'paper', label: 'Paper' }, { value: 'stone', label: 'Stone' }, { value: 'ink', label: 'Ink' },
  { value: 'theme', label: 'Theme' }, { value: 'none', label: 'None' },
]

interface Options { background: Background; padding: number; frame: boolean; numbers: boolean; title: string; fontSize: number }

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

function draw(canvas: HTMLCanvasElement, capture: CodeCapture, options: Options, colors: ReturnType<typeof resolve>['colors'], font: string, ligatures: boolean) {
  const scale = 2
  const context = canvas.getContext('2d')!
  const size = options.fontSize
  const lineHeight = Math.round(size * 1.65)
  const mono = `${size}px ${font}`
  context.font = mono
  const charWidth = context.measureText('0').width
  const lines = capture.lines.map(line => line.map(token => ({ ...token, text: token.text.replace(/\t/g, '    ') })))
  const columns = Math.max(16, ...lines.map(line => line.reduce((sum, token) => sum + token.text.length, 0)))
  const lastNumber = capture.startLine + lines.length - 1
  const gutter = options.numbers ? (String(lastNumber).length + 2) * charWidth : 0
  const innerX = 26, innerY = 22
  const bar = options.frame ? 42 : 0
  const panelWidth = Math.ceil(gutter + columns * charWidth + innerX * 2)
  const panelHeight = Math.ceil(bar + lines.length * lineHeight + innerY * 2)
  const pad = options.background === 'none' ? Math.min(options.padding, 24) : options.padding
  const width = panelWidth + pad * 2, height = panelHeight + pad * 2
  canvas.width = width * scale
  canvas.height = height * scale
  context.setTransform(scale, 0, 0, scale, 0, 0)
  context.clearRect(0, 0, width, height)

  const ground: Record<Background, string> = { paper: '#f4f4f5', stone: '#d6d3d1', ink: '#18181b', theme: colors.bar, none: 'transparent' }
  if (options.background !== 'none') {
    context.fillStyle = ground[options.background]
    context.fillRect(0, 0, width, height)
    context.save()
    context.shadowColor = options.background === 'ink' ? 'rgba(0,0,0,0.5)' : 'rgba(24,24,27,0.16)'
    context.shadowBlur = 36
    context.shadowOffsetY = 14
    roundedRect(context, pad, pad, panelWidth, panelHeight, 12)
    context.fillStyle = colors.editor
    context.fill()
    context.restore()
  }
  roundedRect(context, pad, pad, panelWidth, panelHeight, 12)
  context.fillStyle = colors.editor
  context.fill()
  context.strokeStyle = colors.line
  context.lineWidth = 1
  roundedRect(context, pad + 0.5, pad + 0.5, panelWidth - 1, panelHeight - 1, 12)
  context.stroke()

  if (options.frame) {
    for (let index = 0; index < 3; index++) {
      context.beginPath()
      context.arc(pad + 22 + index * 16, pad + bar / 2, 4.5, 0, Math.PI * 2)
      context.fillStyle = colors.line
      context.fill()
    }
    context.font = `${Math.round(size * 0.86)}px ${font}`
    context.fillStyle = colors.muted
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(options.title, pad + panelWidth / 2, pad + bar / 2)
    context.textAlign = 'left'
    context.fillStyle = colors.line
    context.fillRect(pad, pad + bar, panelWidth, 1)
  }

  const palette: Record<TokenKind, string> = {
    keyword: colors.keyword, string: colors.string, number: colors.number, type: colors.type, function: colors.function,
    variable: colors.variable, property: colors.property, comment: colors.comment, tag: colors.tag, attribute: colors.attribute,
    operator: colors.operator, plain: colors.ink,
  }
  context.textBaseline = 'middle'
  lines.forEach((line, row) => {
    const y = pad + bar + innerY + row * lineHeight + lineHeight / 2
    let x = pad + innerX
    if (options.numbers) {
      context.font = mono
      context.fillStyle = colors.muted
      context.globalAlpha = 0.6
      const label = String(capture.startLine + row)
      context.fillText(label, x + gutter - (label.length + 2) * charWidth, y)
      context.globalAlpha = 1
      x += gutter
    }
    for (const token of line) {
      context.font = token.kind === 'comment' ? `italic ${mono}` : mono
      context.fillStyle = palette[token.kind]
      if (ligatures) context.fillText(token.text, x, y)
      // Drawing one character at a time keeps -> and != as separate characters.
      else for (let index = 0; index < token.text.length; index++) context.fillText(token.text[index], x + index * charWidth, y)
      x += token.text.length * charWidth
    }
  })
}

/** Turns the selected code into a framed image to copy or save. */
export default function CodeShot({ capture, onClose, notify }: { capture: CodeCapture; onClose: () => void; notify: (message: unknown) => void }) {
  const { settings, theme } = useSettings()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [options, setOptions] = useState<Options>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('still.codeshot') ?? '{}')
      return { background: 'paper', padding: 56, frame: true, numbers: false, fontSize: 15, ...saved, title: fileName(capture.path) }
    } catch { return { background: 'paper', padding: 56, frame: true, numbers: false, fontSize: 15, title: fileName(capture.path) } }
  })
  const set = (change: Partial<Options>) => setOptions(value => ({ ...value, ...change }))
  const font = settings.editorFont + ', "JetBrains Mono Variable", ui-monospace, monospace'

  useEffect(() => {
    const { title: _title, ...remember } = options
    try { localStorage.setItem('still.codeshot', JSON.stringify(remember)) } catch { /* storage unavailable */ }
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (!cancelled && canvas.current) draw(canvas.current, capture, options, resolve(theme).colors, font, settings.ligatures)
    })
    return () => { cancelled = true }
  }, [options, capture, theme, font, settings.ligatures])

  async function copy() {
    const node = canvas.current
    if (!node) return
    try {
      const blob = await new Promise<Blob>((done, fail) => node.toBlob(value => value ? done(value) : fail(new Error('Could not create the image.')), 'image/png'))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      notify('Image copied to the clipboard.')
    } catch {
      notify('Copying images is not supported here. Use Save image instead.')
    }
  }

  async function download() {
    const node = canvas.current
    if (!node) return
    const name = options.title.replace(/\.[^.]+$/, '') || 'code'
    const data = node.toDataURL('image/png')
    if (!desktop) {
      const link = document.createElement('a')
      link.href = data
      link.download = name + '.png'
      link.click()
      return
    }
    try {
      const path = await save({ defaultPath: name + '.png', filters: [{ name: 'PNG image', extensions: ['png'] }] })
      if (!path) return
      await invoke('save_png', { path: path.toLowerCase().endsWith('.png') ? path : path + '.png', data })
      notify('Saved ' + fileName(path.replace(/\\/g, '/')))
    } catch (error) { notify(error) }
  }

  return <Modal title="Code image" onClose={onClose} wide className="shot-sheet">
    <div className="sheet-body shot-body">
      <div className="shot-stage"><canvas ref={canvas} aria-label={'Image of ' + capture.lines.length + ' lines from ' + capture.path} role="img" /></div>
      <div className="shot-controls">
        <label className="shot-title">Title<input className="field" value={options.title} onChange={event => set({ title: event.target.value })} spellCheck={false} /></label>
        <div className="shot-row"><span>Background</span><Segmented label="Background" value={options.background} onChange={background => set({ background })} options={backgrounds} /></div>
        <div className="shot-row"><span>Padding</span><Segmented label="Padding" value={options.padding} onChange={padding => set({ padding })} options={[{ value: 32, label: 'S' }, { value: 56, label: 'M' }, { value: 88, label: 'L' }]} /></div>
        <div className="shot-row"><span>Text size</span><Segmented label="Text size" value={options.fontSize} onChange={fontSize => set({ fontSize })} options={[{ value: 13, label: '13' }, { value: 15, label: '15' }, { value: 18, label: '18' }]} /></div>
        <Toggle label="Window bar with title" checked={options.frame} onChange={frame => set({ frame })} />
        <Toggle label="Line numbers" checked={options.numbers} onChange={numbers => set({ numbers })} />
        <p className="help">Colours follow the current theme ({theme.name}). Images are saved at twice the screen size so they stay sharp.</p>
      </div>
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={() => { void copy() }}><Icon glyph={Copy} size={13} />Copy image</button>
        <button type="button" className="text-btn primary" onClick={() => { void download() }}><Icon glyph={Download} size={13} />Save image</button>
      </div>
    </div>
  </Modal>
}
