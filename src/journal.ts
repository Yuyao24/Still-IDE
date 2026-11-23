// A small activity log kept in the web view's storage. It powers the Today list on Home,
// the journal sheet and the idle screen's numbers. Nothing here leaves the computer.

export type JournalKind = 'edit' | 'run' | 'commit' | 'create' | 'clone'
export interface JournalEntry {
  id: string
  time: number
  kind: JournalKind
  project: string
  root: string
  text: string
  detail?: string
  path?: string
  added?: number
  removed?: number
}

const key = 'still.journal'
const limit = 600
const listeners = new Set<() => void>()

function read(): JournalEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

function write(entries: JournalEntry[]) {
  try { localStorage.setItem(key, JSON.stringify(entries.slice(-limit))) } catch { /* storage unavailable */ }
  listeners.forEach(listener => listener())
}

export const journal = {
  list: read,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  clear() { write([]) },
  add(entry: Omit<JournalEntry, 'id' | 'time'>) {
    const entries = read()
    const last = entries.at(-1)
    const now = Date.now()
    // Saving the same file again within ten minutes extends one entry instead of adding many.
    if (entry.kind === 'edit' && last && last.kind === 'edit' && last.root === entry.root && last.path === entry.path && now - last.time < 600000) {
      last.time = now
      last.added = (last.added ?? 0) + (entry.added ?? 0)
      last.removed = (last.removed ?? 0) + (entry.removed ?? 0)
      last.detail = '+' + last.added + ' −' + last.removed
      write(entries)
      return
    }
    entries.push({ ...entry, id: now.toString(36) + Math.random().toString(36).slice(2, 6), time: now })
    write(entries)
  },
}

/** Lines added and removed between two versions, counted as a multiset (fast and close enough for a log). */
export function lineChanges(before: string, after: string) {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added++
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return { added, removed }
}

// ---- Daily numbers for the idle screen ---------------------------------------

export interface DayStats { activeMs: number; added: number; runs: number; passed: number }
const dayKey = () => 'still.day.' + new Date().toISOString().slice(0, 10)

export function today(): DayStats {
  try { return { activeMs: 0, added: 0, runs: 0, passed: 0, ...JSON.parse(localStorage.getItem(dayKey()) ?? '{}') } }
  catch { return { activeMs: 0, added: 0, runs: 0, passed: 0 } }
}

export function bump(change: Partial<DayStats>) {
  const value = today()
  for (const [name, amount] of Object.entries(change) as [keyof DayStats, number][]) value[name] += amount
  try { localStorage.setItem(dayKey(), JSON.stringify(value)) } catch { /* storage unavailable */ }
}

// ---- Where to pick up a project ----------------------------------------------

export interface Resume { path: string; line: number; time: number }
const resumeKey = 'still.resume'

export function resumeFor(root: string): Resume | null {
  try { return (JSON.parse(localStorage.getItem(resumeKey) ?? '{}') as Record<string, Resume>)[root] ?? null }
  catch { return null }
}

export function remember(root: string, value: Resume) {
  try {
    const all = JSON.parse(localStorage.getItem(resumeKey) ?? '{}') as Record<string, Resume>
    all[root] = value
    localStorage.setItem(resumeKey, JSON.stringify(all))
  } catch { /* storage unavailable */ }
}

export function clock(time: number) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function sameDay(a: number, b: number) {
  return new Date(a).toDateString() === new Date(b).toDateString()
}
