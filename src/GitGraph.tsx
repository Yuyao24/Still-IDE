// The commit graph: every branch's commits with lines joining each commit to its parents, branch
// and tag labels, and for the commit you pick, its message, the files it changed and their diffs.
import { useEffect, useMemo, useState } from 'react'
import { GitCommitHorizontal, RefreshCw, Search } from 'lucide-react'
import { history as git, type Diff } from './bridge'
import Editor, { type EditorOptions } from './Editor'
import { Icon, IconButton } from './ui'

export interface GraphCommit { hash: string; short: string; parents: string[]; subject: string; author: string; when: string; refs: string[] }
interface CommitFile { path: string; oldPath: string | null; status: string; additions: number | null; deletions: number | null }
interface CommitDetail { message: string; author: string; date: string; parent: string | null; files: CommitFile[] }

/** One row of lanes: where the commit sits and which lines pass, join or leave. */
interface Row { column: number; top: (string | null)[]; bottom: (string | null)[]; joins: number[]; forks: number[]; merge: boolean }

/** Lays commits out in lanes: each lane waits for the next commit it leads to. */
export function layout(commits: GraphCommit[]): { rows: Row[]; width: number } {
  const lanes: (string | null)[] = []
  const rows: Row[] = []
  let width = 1
  for (const commit of commits) {
    let column = lanes.indexOf(commit.hash)
    if (column < 0) { column = lanes.indexOf(null); if (column < 0) column = lanes.length; lanes[column] = commit.hash }
    const top = lanes.slice()
    // Other lanes that were waiting for this commit end here (branches joining).
    const joins: number[] = []
    top.forEach((hash, index) => { if (hash === commit.hash && index !== column) { joins.push(index); lanes[index] = null } })
    lanes[column] = commit.parents[0] ?? null
    const forks: number[] = []
    for (const parent of commit.parents.slice(1)) {
      let index = lanes.indexOf(parent)
      if (index < 0) { index = lanes.indexOf(null); if (index < 0 || index === column) index = lanes.length; lanes[index] = parent }
      forks.push(index)
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, top.length, lanes.length)
    rows.push({ column, top, bottom: lanes.slice(), joins, forks, merge: commit.parents.length > 1 })
  }
  return { rows, width }
}

const laneColors = ['var(--accent)', 'var(--green)', 'var(--amber)', 'var(--violet, #8a63d2)', 'var(--red)', 'var(--cyan, #2b9eb3)']
const ROW = 28, GAP = 14
const x = (index: number) => 10 + index * GAP

function Lanes({ row, width }: { row: Row; width: number }) {
  const middle = ROW / 2
  const color = (index: number) => laneColors[index % laneColors.length]
  const lines: React.ReactNode[] = []
  row.top.forEach((hash, index) => {
    if (!hash) return
    // Into the commit (its own lane or a joining branch), or straight past it.
    const end = index === row.column || row.joins.includes(index) ? row.column : index
    lines.push(<path key={'t' + index} d={`M${x(index)} 0 C ${x(index)} ${middle * 0.6}, ${x(end)} ${middle * 0.4}, ${x(end)} ${middle}`} stroke={color(index)} />)
  })
  row.bottom.forEach((hash, index) => {
    if (!hash) return
    const fromCommit = index === row.column || row.forks.includes(index)
    const start = fromCommit ? row.column : index
    // A lane that passes by keeps going; a new lane starts at the commit.
    if (!fromCommit && !row.top[index]) return
    lines.push(<path key={'b' + index} d={`M${x(start)} ${middle} C ${x(start)} ${middle + middle * 0.6}, ${x(index)} ${middle + middle * 0.4}, ${x(index)} ${ROW}`} stroke={color(index === row.column ? row.column : index)} />)
  })
  return <svg className="graph-lanes" width={x(width) + 4} height={ROW} aria-hidden="true">
    <g fill="none" strokeWidth="1.6">{lines}</g>
    <circle cx={x(row.column)} cy={middle} r={row.merge ? 3.6 : 4} fill={row.merge ? 'var(--editor)' : color(row.column)} stroke={color(row.column)} strokeWidth="1.6" />
  </svg>
}

function RefLabel({ name }: { name: string }) {
  const head = name.startsWith('HEAD -> ')
  const label = head ? name.slice(8) : name.replace(/^tag: /, '')
  const kind = name.startsWith('tag: ') ? 'is-tag' : label.includes('/') ? 'is-remote' : 'is-branch'
  if (name === 'HEAD') return null
  return <span className={'graph-ref ' + kind + (head ? ' is-head' : '')} title={head ? 'Current branch' : undefined}>{label}</span>
}

export function GitGraph({ rootPath, notify, editorOptions, onOpenFile }: { rootPath: string; notify: (message: unknown) => void; editorOptions: EditorOptions; onOpenFile: (path: string) => void }) {
  const [commits, setCommits] = useState<GraphCommit[] | null>(null)
  const [picked, setPicked] = useState<GraphCommit | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [file, setFile] = useState<{ path: string; diff: Diff } | null>(null)
  const [filter, setFilter] = useState('')
  async function load() {
    try { setCommits(await git.graph(rootPath)) } catch (error) { notify(error); setCommits([]) }
  }
  useEffect(() => { void load() }, [rootPath])
  useEffect(() => {
    if (!picked) return
    setDetail(null); setFile(null)
    let live = true
    void git.commitDetail(rootPath, picked.hash).then(found => { if (live) setDetail(found) }).catch(error => { if (live) notify(error) })
    return () => { live = false }
  }, [picked?.hash])
  const { rows, width } = useMemo(() => layout(commits ?? []), [commits])
  const term = filter.trim().toLowerCase()
  const visible = (commit: GraphCommit) => !term || commit.subject.toLowerCase().includes(term) || commit.author.toLowerCase().includes(term) || commit.hash.startsWith(term) || commit.refs.some(ref => ref.toLowerCase().includes(term))
  async function openDiff(item: CommitFile) {
    if (!picked || !detail) return
    const before = detail.parent ? await git.showAt(rootPath, detail.parent, item.oldPath ?? item.path).catch(() => '') : ''
    const after = item.status === 'D' ? '' : await git.showAt(rootPath, picked.hash, item.path).catch(() => '')
    setFile({ path: item.path, diff: { before, after } })
  }
  return <>
    <div className="full-side island side graph-side">
      <div className="graph-head">
        <span className="graph-search"><Icon glyph={Search} size={12} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter by message, author, branch or hash" aria-label="Filter commits" /></span>
        <IconButton glyph={RefreshCw} label="Refresh" onClick={() => { void load() }} />
      </div>
      <div className="graph-list" role="list">
        {!commits && <p className="full-empty">Loading…</p>}
        {commits && !commits.length && <p className="full-empty">No commits yet.</p>}
        {commits?.map((commit, index) => <button key={commit.hash} role="listitem" className={'graph-row' + (picked?.hash === commit.hash ? ' is-active' : '') + (visible(commit) ? '' : ' is-dimmed')} onClick={() => setPicked(commit)}>
          <Lanes row={rows[index]} width={Math.min(width, 14)} />
          <span className="graph-text">
            <span className="graph-subject">{commit.refs.map(ref => <RefLabel key={ref} name={ref} />)}{commit.subject}</span>
            <span className="graph-meta">{commit.author} · {commit.when} · {commit.short}</span>
          </span>
        </button>)}
      </div>
    </div>
    <div className="full-main graph-main">
      {!picked ? <p className="full-empty"><Icon glyph={GitCommitHorizontal} size={14} /> Choose a commit to see what it changed.</p> : <>
        <header className="graph-detail">
          <pre className="graph-message">{detail?.message ?? picked.subject}</pre>
          <p className="muted">{detail ? detail.author + ' · ' + detail.date : picked.author} · <code>{picked.short}</code>{picked.parents.length > 1 ? ' · merge' : ''}</p>
          <div className="graph-files">
            {!detail && <p className="muted">Loading…</p>}
            {detail?.files.map(item => <button key={item.path} className={'graph-file' + (file?.path === item.path ? ' is-active' : '')} onClick={() => { void openDiff(item) }} onDoubleClick={() => onOpenFile(item.path)} title="Click for the diff, double-click to open the file">
              <span className={'graph-status is-' + item.status}>{item.status}</span><span className="graph-file-name">{item.oldPath ? item.oldPath + ' → ' : ''}{item.path}</span>
              <span className="graph-stat">{item.additions !== null && <b className="is-add">+{item.additions}</b>} {item.deletions !== null && <b className="is-del">−{item.deletions}</b>}</span>
            </button>)}
            {detail && !detail.files.length && <p className="muted">No file changes (a merge without conflicts, or an empty commit).</p>}
          </div>
        </header>
        {file && <div className="full-editor graph-diff"><Editor key={picked.hash + file.path} path={file.path} text={file.diff.after} diff={file.diff} options={{ ...editorOptions, layout: 'split' }} diagnostics={[]} onEdit={() => {}} onCursor={() => {}} handle={() => {}} /></div>}
      </>}
    </div>
  </>
}
