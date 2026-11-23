import { useEffect, useState } from 'react'
import { type JournalEntry, clock, journal, sameDay } from './journal'
import { Modal } from './ui'

export function useJournal() {
  const [entries, setEntries] = useState(journal.list)
  useEffect(() => journal.subscribe(() => setEntries(journal.list())), [])
  return entries
}

export function entryText(entry: JournalEntry) {
  return <>{entry.text}{entry.detail && <span className="muted"> {entry.detail}</span>}</>
}

function dayLabel(time: number) {
  const now = Date.now()
  if (sameDay(time, now)) return 'Today'
  if (sameDay(time, now - 86400000)) return 'Yesterday'
  return new Date(time).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

/** Every recorded step, newest first, grouped by day. Optionally only one project. */
export function JournalSheet({ root, onClose, onOpen }: { root?: string; onClose: () => void; onOpen?: (entry: JournalEntry) => void }) {
  const all = useJournal()
  const [mine, setMine] = useState(Boolean(root))
  const entries = [...all].reverse().filter(entry => !mine || entry.root === root)
  const days: { label: string; items: JournalEntry[] }[] = []
  for (const entry of entries.slice(0, 300)) {
    const label = dayLabel(entry.time)
    if (days.at(-1)?.label === label) days.at(-1)!.items.push(entry)
    else days.push({ label, items: [entry] })
  }
  return <Modal title="Journal" onClose={onClose} wide>
    <div className="sheet-body journal-sheet">
      {root && <nav className="under-tabs small" aria-label="Journal scope">
        <button className={mine ? 'is-active' : ''} onClick={() => setMine(true)}>This project</button>
        <button className={!mine ? 'is-active' : ''} onClick={() => setMine(false)}>Everything</button>
      </nav>}
      {!days.length && <p className="help">Nothing yet. Saving files, running code and committing are noted here as you work.</p>}
      {days.map(day => <section key={day.label}>
        <h3>{day.label}</h3>
        {day.items.map(entry => <button key={entry.id} className="journal-row" onClick={() => onOpen?.(entry)} disabled={!onOpen}>
          <time>{clock(entry.time)}</time><span>{entryText(entry)}</span>{!mine && <small>{entry.project}</small>}
        </button>)}
      </section>)}
      {entries.length > 0 && <div className="sheet-actions"><button className="text-btn" onClick={() => journal.clear()}>Clear journal</button></div>}
    </div>
  </Modal>
}
