// The Database tab: SQLite files found in the project and Postgres servers (DATABASE_URL in .env,
// or ones you add). Pick a table to see its rows; write SQL and run it with Ctrl+Enter.
// Postgres passwords go to the system's credential store, not Still's settings.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, ChevronRight, Database as DatabaseGlyph, Download, KeyRound, Play, Plus, RefreshCw, Table2, Trash2, Eye } from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { Icon, IconButton } from './ui'
import { desktop, launcher } from './bridge'

export interface DbConnection { id: string; label: string; kind: 'sqlite' | 'postgres'; path?: string; url?: string; key?: string; source: 'file' | 'env' | 'saved' }
interface DbColumn { name: string; type: string; key: boolean }
interface DbTable { schema: string; name: string; view: boolean; columns: DbColumn[] }
interface DbResult { columns: string[]; rows: (string | null)[][]; changed: number | null; truncated: boolean; millis: number; statements: number }

const sqliteFile = /\.(db|sqlite|sqlite3|db3)$/i

/** A Postgres URL without its password, and the password if it had one. */
function splitPassword(url: string): { url: string; password: string | null; key: string } {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:/, 'http:'))
    const password = parsed.password ? decodeURIComponent(parsed.password) : null
    parsed.password = ''
    const clean = url.replace(/^(postgres(?:ql)?:\/\/)([^@/]*)@/, (_, scheme: string, auth: string) => scheme + auth.split(':')[0] + '@')
    return { url: password ? clean : url, password, key: `${parsed.username}@${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}` }
  } catch { return { url, password: null, key: url } }
}

function labelFor(url: string) {
  try { const parsed = new URL(url.replace(/^postgres(ql)?:/, 'http:')); return (parsed.pathname.slice(1) || 'postgres') + ' on ' + parsed.hostname + (parsed.port ? ':' + parsed.port : '') } catch { return url }
}

const quoteName = (name: string) => '"' + name.replace(/"/g, '""') + '"'

export function DatabasePanel({ root, files, readFile, remote, focus, notify }: {
  root: string; files: () => Promise<string[]>; readFile: (path: string) => Promise<string>; remote: boolean
  /** A database file to select (opened from the file tree). */
  focus: { path: string; nonce: number } | null
  notify: (message: string) => void
}) {
  const savedKey = 'still.db.' + root
  const [found, setFound] = useState<DbConnection[]>([])
  const [saved, setSaved] = useState<DbConnection[]>(() => { try { return JSON.parse(localStorage.getItem(savedKey) || '[]') as DbConnection[] } catch { return [] } })
  const connections = useMemo(() => [...found, ...saved], [found, saved])
  const [selected, setSelected] = useState<string | null>(null)
  const [tables, setTables] = useState<Record<string, DbTable[] | 'loading' | { error: string }>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<DbResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ url: '', password: '' })
  const input = useRef<HTMLTextAreaElement>(null)
  const current = connections.find(item => item.id === selected) ?? null

  async function scan() {
    if (!desktop || remote) return
    const list: DbConnection[] = []
    try { for (const path of (await files()).filter(path => sqliteFile.test(path)).slice(0, 30)) list.push({ id: 'file:' + path, label: path, kind: 'sqlite', path, source: 'file' }) } catch { /* no file list */ }
    try {
      const env = await readFile('.env')
      const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*["']?(postgres(?:ql)?:\/\/[^\s"']+)/m.exec(env)
      if (match) list.push({ id: 'env', label: labelFor(match[1]) + ' (.env)', kind: 'postgres', url: match[1], source: 'env' })
    } catch { /* no .env */ }
    setFound(list)
    setSelected(previous => previous ?? list[0]?.id ?? saved[0]?.id ?? null)
  }
  useEffect(() => { void scan() }, [root])
  useEffect(() => {
    if (!focus) return
    const id = 'file:' + focus.path
    setFound(previous => previous.some(item => item.id === id) ? previous : [...previous, { id, label: focus.path, kind: 'sqlite', path: focus.path, source: 'file' }])
    setSelected(id)
    setOpen(previous => new Set([...previous, id]))
    void loadTables({ id, label: focus.path, kind: 'sqlite', path: focus.path, source: 'file' })
  }, [focus?.nonce])
  useEffect(() => { try { localStorage.setItem(savedKey, JSON.stringify(saved)) } catch { /* private window */ } }, [saved])
  // Each connection remembers the SQL you last wrote for it.
  useEffect(() => { if (selected) { try { setSql(localStorage.getItem('still.db.sql.' + root + '.' + selected) ?? '') } catch { setSql('') } setResult(null); setError(null) } }, [selected])
  useEffect(() => { if (selected) { try { localStorage.setItem('still.db.sql.' + root + '.' + selected, sql) } catch { /* private window */ } } }, [sql])

  const connArg = (item: DbConnection) => ({ kind: item.kind, path: item.path ?? null, rootPath: root, url: item.url ?? null, key: item.key ?? null })
  async function loadTables(item: DbConnection) {
    setTables(previous => ({ ...previous, [item.id]: 'loading' }))
    try { const list = await invoke<DbTable[]>('db_tables', { conn: connArg(item) }); setTables(previous => ({ ...previous, [item.id]: list })) }
    catch (problem) { setTables(previous => ({ ...previous, [item.id]: { error: String(problem) } })) }
  }
  function toggle(key: string, item?: DbConnection) {
    setOpen(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })
    if (item && !tables[item.id]) void loadTables(item)
  }
  // A table opened from the list (SELECT * … with a primary key) can be edited cell by cell.
  const lastRun = useRef('')
  const [editable, setEditable] = useState<{ sql: string; conn: string; name: string; keys: string[] } | null>(null)
  const [editing, setEditing] = useState<{ row: number; column: number; value: string } | null>(null)
  const canEdit = Boolean(editable && result && current && editable.conn === current.id && editable.sql === lastRun.current && editable.keys.every(key => result.columns.includes(key)))
  const literal = (value: string | null) => value === null ? 'NULL' : "'" + value.replace(/'/g, "''") + "'"
  async function saveCell(row: number, column: number, value: string) {
    if (!editable || !result || !current) return
    const original = result.rows[row]
    const next = value === 'NULL' ? null : value
    if (next === original[column]) { setEditing(null); return }
    const where = editable.keys.map(key => quoteName(key) + (original[result.columns.indexOf(key)] === null ? ' IS NULL' : ' = ' + literal(original[result.columns.indexOf(key)]))).join(' AND ')
    const statement = `UPDATE ${editable.name} SET ${quoteName(result.columns[column])} = ${literal(next)} WHERE ${where}`
    try {
      const done = await invoke<DbResult>('db_query', { conn: connArg(current), sql: statement })
      if (done.changed !== 1) { notify(done.changed ? 'That changed ' + done.changed + ' rows; check the table.' : 'No row matched; the table may have changed. Run the query again.'); return }
      setResult(previous => previous && { ...previous, rows: previous.rows.map((cells, index) => index === row ? cells.map((cell, at) => at === column ? next : cell) : cells) })
      setEditing(null)
    } catch (problem) { notify('Couldn’t save: ' + String(problem)) }
  }
  function exportCsv() {
    if (!result?.columns.length) return
    const cell = (value: string | null) => value === null ? '' : /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value
    const csv = [result.columns.map(cell), ...result.rows.map(row => row.map(cell))].map(row => row.join(',')).join('\r\n') + '\r\n'
    const base = (editable?.name.replace(/"/g, '').split('.').at(-1) ?? 'results') + '.csv'
    if (!desktop) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = base; link.click(); return }
    void save({ title: 'Export results as CSV', defaultPath: base, filters: [{ name: 'CSV', extensions: ['csv'] }] }).then(path => {
      if (path) return launcher.writeText(path, csv).then(() => notify('Saved ' + result.rows.length + ' rows to ' + path.split(/[\\/]/).at(-1) + '.'))
    }).catch(problem => notify(String(problem)))
  }

  async function run(text = sql, on = current) {
    if (!on) { notify('Pick a database first.'); return }
    if (!text.trim()) return
    lastRun.current = text
    setEditing(null)
    setRunning(true); setError(null)
    try { setResult(await invoke<DbResult>('db_query', { conn: connArg(on), sql: text })) }
    catch (problem) { setError(String(problem)); setResult(null) }
    finally { setRunning(false) }
    // A statement may have made or dropped tables.
    if (/\b(create|drop|alter)\b/i.test(text)) void loadTables(on)
  }
  function showTable(item: DbConnection, table: DbTable) {
    const name = (item.kind === 'postgres' && table.schema && table.schema !== 'public' ? quoteName(table.schema) + '.' : '') + quoteName(table.name)
    const text = `SELECT * FROM ${name} LIMIT 200;`
    const keys = table.columns.filter(column => column.key).map(column => column.name)
    setEditable(keys.length && !table.view ? { sql: text, conn: item.id, name, keys } : null)
    setSelected(item.id); setSql(text)
    setTimeout(() => { void run(text, item) }, 0)
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      const area = event.currentTarget
      const chosen = area.selectionStart !== area.selectionEnd ? area.value.slice(area.selectionStart, area.selectionEnd) : area.value
      void run(chosen)
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault()
    const text = form.url.trim()
    if (!/^postgres(ql)?:\/\//.test(text)) { notify('Use a postgres:// address, like postgres://user@localhost:5432/shop'); return }
    const parts = splitPassword(text)
    const password = form.password || parts.password
    // The password goes to the system keychain; the address is saved without it.
    if (password) {
      try { if (await invoke<string>('db_save_password', { key: parts.key, password }) === 'session') notify('There’s no system keychain to keep the password in, so Still will ask for it again next time.') }
      catch (problem) { notify('Couldn’t keep the password: ' + String(problem)); return }
    }
    const item: DbConnection = { id: 'saved:' + crypto.randomUUID(), label: labelFor(parts.url), kind: 'postgres', url: parts.url, key: parts.key, source: 'saved' }
    setSaved(previous => [...previous, item])
    setSelected(item.id); setAdding(false); setForm({ url: '', password: '' })
    setOpen(previous => new Set([...previous, item.id]))
    void loadTables(item)
  }
  function forget(item: DbConnection) {
    setSaved(previous => previous.filter(other => other.id !== item.id))
    if (item.key) void invoke('db_forget_password', { key: item.key }).catch(() => {})
    if (selected === item.id) setSelected(null)
  }

  if (!desktop) return <p className="dbg-empty tests-empty"><Icon glyph={DatabaseGlyph} size={13} /> The database panel works in the Still desktop app.</p>
  if (remote) return <p className="dbg-empty tests-empty"><Icon glyph={DatabaseGlyph} size={13} /> The database panel works with projects on this computer for now.</p>
  return <div className="db">
    <aside className="db-side">
      <div className="db-side-head">
        <span className="section-label">Databases</span>
        <span className="flex items-center gap-0.5">
          <IconButton glyph={RefreshCw} label="Look for databases again" onClick={() => { void scan(); for (const item of connections) if (tables[item.id]) void loadTables(item) }} />
          <IconButton glyph={Plus} label="Add a Postgres server" onClick={() => setAdding(value => !value)} />
        </span>
      </div>
      {adding && <form className="db-add" onSubmit={add}>
        <input className="field" placeholder="postgres://user@localhost:5432/shop" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} aria-label="Postgres address" spellCheck={false} autoFocus />
        <input className="field" type="password" placeholder="Password (optional)" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} aria-label="Password" />
        <p className="help">The password is kept in the system keychain, not in Still’s settings.</p>
        <div className="flex justify-end gap-2"><button type="button" className="text-btn" onClick={() => setAdding(false)}>Cancel</button><button type="submit" className="text-btn primary">Add</button></div>
      </form>}
      <div className="db-tree">
        {!connections.length && !adding && <p className="help px-3 py-2">No databases yet. SQLite files in the project show here, and a DATABASE_URL in .env. Use + to add a Postgres server.</p>}
        {connections.map(item => {
          const listed = tables[item.id]
          const expanded = open.has(item.id)
          return <div key={item.id}>
            <div className={'db-row db-conn' + (selected === item.id ? ' is-active' : '')}>
              <button className="db-twisty" onClick={() => toggle(item.id, item)} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded}><Icon glyph={expanded ? ChevronDown : ChevronRight} size={12} /></button>
              <button className="db-label" onClick={() => { setSelected(item.id); if (!expanded) toggle(item.id, item) }} title={item.kind === 'sqlite' ? item.path : item.url}>
                <Icon glyph={DatabaseGlyph} size={13} /><span className="truncate">{item.label}</span><span className="db-kind">{item.kind === 'sqlite' ? 'SQLite' : 'Postgres'}</span>
              </button>
              {item.source === 'saved' && <button className="db-forget" onClick={() => forget(item)} title="Remove this server (and its saved password)" aria-label={'Remove ' + item.label}><Icon glyph={Trash2} size={12} /></button>}
            </div>
            {expanded && (listed === 'loading' || listed === undefined ? <p className="help db-note">Loading tables…</p>
              : 'error' in (listed as object) ? <p className="db-note db-error">{(listed as { error: string }).error}</p>
              : !(listed as DbTable[]).length ? <p className="help db-note">No tables yet.</p>
              : (listed as DbTable[]).map(table => {
                const key = item.id + '/' + table.schema + '.' + table.name
                const shown = open.has(key)
                return <div key={key}>
                  <div className="db-row db-table">
                    <button className="db-twisty" onClick={() => toggle(key)} aria-label={shown ? 'Hide columns' : 'Show columns'} aria-expanded={shown}><Icon glyph={shown ? ChevronDown : ChevronRight} size={12} /></button>
                    <button className="db-label" onClick={() => showTable(item, table)} title={'Show rows of ' + table.name}>
                      <Icon glyph={table.view ? Eye : Table2} size={13} /><span className="truncate">{table.schema && table.schema !== 'public' ? table.schema + '.' : ''}{table.name}</span>
                    </button>
                  </div>
                  {shown && table.columns.map(column => <div key={column.name} className="db-row db-column" title={column.type}>
                    {column.key ? <Icon glyph={KeyRound} size={11} /> : <span className="db-column-gap" />}<span className="truncate">{column.name}</span><span className="db-kind">{column.type.toLowerCase()}</span>
                  </div>)}
                </div>
              }))}
          </div>
        })}
      </div>
    </aside>
    <section className="db-main">
      <div className="db-query">
        <textarea ref={input} className="db-sql" value={sql} onChange={event => setSql(event.target.value)} onKeyDown={keyDown} spellCheck={false}
          placeholder={current ? 'SQL for ' + current.label + '. Ctrl+Enter runs it (or just the selected part).' : 'Pick a database on the left.'} aria-label="SQL" />
        <div className="db-actions">
          <button className="text-btn primary" disabled={!current || running || !sql.trim()} onClick={() => { void run() }}><Icon glyph={Play} size={12} />Run</button>
          <span className={'dbg-status' + (error ? ' is-error' : '')}>
            {running ? 'Running…' : error ? 'The query failed.' : result ? (result.columns.length ? `${result.rows.length}${result.truncated ? '+' : ''} row${result.rows.length === 1 ? '' : 's'}` : `${result.changed ?? 0} row${result.changed === 1 ? '' : 's'} changed`) + ` · ${result.millis} ms${result.statements > 1 ? ' · ' + result.statements + ' statements' : ''}` : current ? current.label : ''}
          </span>
          <span className="flex-1" />
          {canEdit && <span className="help db-hint">Double-click a cell to edit it</span>}
          {result && result.columns.length > 0 && <button className="text-btn" onClick={exportCsv}><Icon glyph={Download} size={12} />Export CSV</button>}
        </div>
      </div>
      <div className="db-results">
        {error ? <pre className="db-error-text">{error}</pre>
          : result && result.columns.length ? <table className="db-grid">
            <thead><tr><th className="db-num">#</th>{result.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
            <tbody>{result.rows.map((row, index) => <tr key={index}><td className="db-num">{index + 1}</td>{row.map((cell, column) => editing && editing.row === index && editing.column === column
              ? <td key={column} className="is-editing"><input autoFocus className="db-cell-input" value={editing.value} aria-label={'Edit ' + result.columns[column]} spellCheck={false}
                  onChange={event => setEditing({ ...editing, value: event.target.value })} onBlur={() => setEditing(null)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveCell(index, column, editing.value) } else if (event.key === 'Escape') { event.preventDefault(); setEditing(null) } }} /></td>
              : <td key={column} className={cell === null ? 'is-null' : ''} title={cell && cell.length > 80 ? cell.slice(0, 2000) : canEdit ? 'Double-click to edit' : undefined}
                  onDoubleClick={canEdit ? () => setEditing({ row: index, column, value: cell ?? 'NULL' }) : undefined}>{cell === null ? 'NULL' : cell.length > 200 ? cell.slice(0, 200) + '…' : cell}</td>)}</tr>)}</tbody>
          </table>
          : result ? <p className="dbg-empty tests-empty">Done. {result.changed ?? 0} row{result.changed === 1 ? '' : 's'} changed.</p>
          : <p className="dbg-empty tests-empty"><Icon glyph={DatabaseGlyph} size={13} /> Pick a table to see its rows, or write SQL above.</p>}
        {result?.truncated && <p className="help db-note">Showing the first {result.rows.length} rows. Add LIMIT to see a particular part.</p>}
      </div>
    </section>
  </div>
}
