import { useEffect, useState } from 'react'
import { type DayStats, today } from './activity'

export interface IdleSource { path: string; project: string; text: string; edited?: number }

/** Resolves after `minutes` without keyboard, pointer or wheel input. Zero turns it off. */
export function useIdle(minutes: number, paused = false) {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!minutes || paused) { setIdle(false); return }
    let timer = 0
    const reset = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), minutes * 60000)
    }
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const
    events.forEach(name => addEventListener(name, reset, { passive: true, capture: true }))
    reset()
    return () => { clearTimeout(timer); events.forEach(name => removeEventListener(name, reset, { capture: true })) }
  }, [minutes, paused])
  return [idle, () => setIdle(false)] as const
}

function excerpt(source: IdleSource, seed: number) {
  const lines = source.text.split('\n')
  // Prefer the start of a function or class so the excerpt reads as a whole.
  const starts = lines.map((line, index) => /^\s*(def |class |public |private |static |function |export |fn |func |const \w+ = \(|async )/.test(line) ? index : -1).filter(index => index >= 0)
  const start = starts.length ? starts[seed % starts.length] : Math.max(0, (seed * 7) % Math.max(1, lines.length - 6))
  const chunk: string[] = []
  for (let index = start; index < lines.length && chunk.length < 7; index++) {
    if (!lines[index].trim() && chunk.length >= 3) break
    chunk.push(lines[index])
  }
  const indent = Math.min(...chunk.filter(line => line.trim()).map(line => line.match(/^\s*/)![0].length))
  return { lines: chunk.map(line => line.slice(Number.isFinite(indent) ? indent : 0).slice(0, 72)), from: start + 1 }
}

function ago(time?: number) {
  if (!time) return ''
  const minutes = Math.round((Date.now() - time) / 60000)
  return minutes < 2 ? 'edited just now' : minutes < 60 ? 'edited ' + minutes + ' minutes ago' : 'edited ' + Math.round(minutes / 60) + ' hours ago'
}

function duration(ms: number) {
  const minutes = Math.round(ms / 60000)
  return minutes < 60 ? minutes + 'm' : Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
}

/** A calm screen for when you step away: drifting code, one excerpt at a time, the time and today's numbers. */
export function Idle({ sources, onWake, sessionStats, leaving }: { sources: IdleSource[]; onWake: () => void; sessionStats?: Partial<DayStats>; leaving?: boolean }) {
  const [now, setNow] = useState(new Date())
  const [turn, setTurn] = useState(0)
  const [stats] = useState(today)
  const usable = sources.filter(source => source.text.split('\n').filter(line => line.trim()).length >= 3)
    .sort((a, b) => Number(/\.(md|txt|text)$/i.test(a.path)) - Number(/\.(md|txt|text)$/i.test(b.path)))
  useEffect(() => {
    const clockTimer = setInterval(() => setNow(new Date()), 15000)
    const turnTimer = setInterval(() => setTurn(value => value + 1), 12000)
    if (leaving) return () => { clearInterval(clockTimer); clearInterval(turnTimer) }
    const wake = (event: Event) => { event.preventDefault(); event.stopPropagation(); onWake() }
    // A short grace period so the move that hid the cursor doesn't wake it at once.
    const arm = setTimeout(() => {
      addEventListener('keydown', wake, true); addEventListener('pointerdown', wake, true); addEventListener('pointermove', wake, true)
    }, 600)
    return () => {
      clearInterval(clockTimer); clearInterval(turnTimer); clearTimeout(arm)
      removeEventListener('keydown', wake, true); removeEventListener('pointerdown', wake, true); removeEventListener('pointermove', wake, true)
    }
  }, [onWake, leaving])

  const source = usable.length ? usable[turn % usable.length] : null
  const shown = source ? excerpt(source, turn + source.path.length) : null
  const active = stats.activeMs + (sessionStats?.activeMs ?? 0)

  return <div className={'idle' + (leaving ? ' is-leaving' : '')} role="dialog" aria-label="Idle screen. Press any key to return." aria-hidden={leaving || undefined}>
    <span className="idle-hint">Press any key to resume</span>
    {source && shown && <div className="idle-center"><section key={turn} className="idle-excerpt">
      <span>{source.project} · {source.path} · lines {shown.from}–{shown.from + shown.lines.length - 1}{source.edited ? ' · ' + ago(source.edited) : ''}</span>
      <pre>{shown.lines.join('\n')}</pre>
    </section></div>}
    <footer className="idle-foot">
      <div>
        <span className="idle-time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        <span className="idle-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
      <div className="idle-stats">
        <span><small>Today</small>{duration(active)}</span>
        <span><small>Lines</small>+{stats.added + (sessionStats?.added ?? 0)}</span>
        <span><small>Runs</small>{stats.runs + (sessionStats?.runs ?? 0) ? (stats.passed + (sessionStats?.passed ?? 0)) + ' passed' : 'none'}</span>
      </div>
    </footer>
  </div>
}
