// Pull requests on GitHub for this repository: read the description, the changed files and the
// conversation, check one out locally to try it, and reply. Uses the GitHub token from Settings → AI
// (needed for private repositories and for commenting; public ones can be read without it).
import { useEffect, useMemo, useState } from 'react'
import { fetch as appFetch } from '@tauri-apps/plugin-http'
import { ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import { api, desktop } from './bridge'
import { keys } from './ai'
import { renderMarkdown } from './Preview'
import { Icon, IconButton, relativeTime } from './ui'

interface Pull { number: number; title: string; user: { login: string }; head: { ref: string }; base: { ref: string }; created_at: string; updated_at: string; draft: boolean; body: string | null; html_url: string; comments?: number }
interface PullFile { filename: string; status: string; additions: number; deletions: number; patch?: string }
interface Comment { id: number; user: { login: string }; body: string; created_at: string }

export function repoFrom(url: string): { owner: string; repo: string } | null {
  const found = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return found ? { owner: found[1], repo: found[2] } : null
}

async function github<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await keys.get('github').catch(() => null)
  const response = await (desktop ? appFetch : fetch)('https://api.github.com' + path, {
    method: init.method ?? 'GET',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text
    try { message = JSON.parse(text).message ?? text } catch { /* plain text */ }
    if (response.status === 404) throw new Error(token ? 'GitHub could not find this repository (check the token can read it).' : 'GitHub could not find this repository. If it is private, add a GitHub token in Settings → AI.')
    if (response.status === 401 || response.status === 403) throw new Error((token ? 'GitHub refused the token: ' : 'GitHub needs a token for this (Settings → AI): ') + message)
    throw new Error('GitHub: ' + (message || response.status))
  }
  return response.json() as Promise<T>
}

function PatchView({ patch }: { patch: string }) {
  return <pre className="pr-patch">{patch.split('\n').map((line, index) => <span key={index} className={line.startsWith('@@') ? 'is-hunk' : line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-del' : ''}>{line + '\n'}</span>)}</pre>
}

export function PullRequests({ rootPath, notify, onCheckedOut, onLink }: { rootPath: string; notify: (message: unknown) => void; onCheckedOut: () => void; onLink: (url: string) => void }) {
  const [repo, setRepo] = useState<{ owner: string; repo: string } | null | undefined>(undefined)
  const [pulls, setPulls] = useState<Pull[] | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Pull | null>(null)
  const [files, setFiles] = useState<PullFile[] | null>(null)
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setError('')
    try {
      const found = repoFrom(await api.remoteUrl(rootPath))
      setRepo(found)
      if (!found) return
      setPulls(await github<Pull[]>(`/repos/${found.owner}/${found.repo}/pulls?state=open&per_page=50`))
    } catch (problem) { setError(String((problem as Error).message ?? problem)); setPulls([]) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!picked || !repo) return
    setFiles(null); setComments(null)
    let live = true
    void github<PullFile[]>(`/repos/${repo.owner}/${repo.repo}/pulls/${picked.number}/files?per_page=100`).then(list => { if (live) setFiles(list) }).catch(problem => { if (live) { setFiles([]); notify(problem) } })
    void github<Comment[]>(`/repos/${repo.owner}/${repo.repo}/issues/${picked.number}/comments?per_page=100`).then(list => { if (live) setComments(list) }).catch(() => { if (live) setComments([]) })
    return () => { live = false }
  }, [picked?.number])
  const body = useMemo(() => picked?.body ? renderMarkdown(picked.body) : '', [picked?.body])

  async function checkout() {
    if (!picked) return
    setBusy(true)
    try { const branch = await api.checkoutPr(rootPath, picked.number); notify('Switched to ' + branch + ' (pull request #' + picked.number + ').'); onCheckedOut() }
    catch (problem) { notify(problem) } finally { setBusy(false) }
  }
  async function send() {
    if (!picked || !repo || !reply.trim()) return
    setBusy(true)
    try {
      const comment = await github<Comment>(`/repos/${repo.owner}/${repo.repo}/issues/${picked.number}/comments`, { method: 'POST', body: { body: reply.trim() } })
      setComments(previous => [...(previous ?? []), comment]); setReply('')
    } catch (problem) { notify(problem) } finally { setBusy(false) }
  }

  return <>
    <div className="full-side island side pr-side">
      <div className="pr-side-head"><span>{repo ? repo.owner + '/' + repo.repo : 'Pull requests'}</span><IconButton glyph={RefreshCw} label="Refresh" onClick={() => { void load() }} /></div>
      <div className="history-list">
        {repo === null && <p className="full-empty">This project's origin isn't on GitHub.</p>}
        {error && <p className="full-empty">{error}</p>}
        {pulls?.length === 0 && !error && repo && <p className="full-empty">No open pull requests.</p>}
        {!pulls && repo !== null && !error && <p className="full-empty">Loading…</p>}
        {pulls?.map(pull => <button key={pull.number} className={'history-row' + (picked?.number === pull.number ? ' is-active' : '')} onClick={() => setPicked(pull)}>
          <b><span className="pr-number">#{pull.number}</span> {pull.title}{pull.draft ? ' · draft' : ''}</b>
          <span>{pull.user.login} · {pull.head.ref} → {pull.base.ref} · {relativeTime(Date.parse(pull.updated_at))}</span>
        </button>)}
      </div>
    </div>
    <div className="full-main pr-main">
      {!picked ? <p className="full-empty"><Icon glyph={GitPullRequest} size={14} /> Choose a pull request to read it.</p> : <div className="pr-detail">
        <header className="pr-head">
          <h2>{picked.title} <span className="pr-number">#{picked.number}</span></h2>
          <p className="muted">{picked.user.login} wants to merge <code>{picked.head.ref}</code> into <code>{picked.base.ref}</code> · opened {relativeTime(Date.parse(picked.created_at))}</p>
          <div className="pr-actions">
            <button className="text-btn primary" disabled={busy} onClick={() => { void checkout() }}>Check out locally</button>
            <button className="text-btn" onClick={() => onLink(picked.html_url)}><Icon glyph={ExternalLink} size={12} />Open on GitHub</button>
          </div>
        </header>
        {body ? <article className="doc-markdown pr-body" dangerouslySetInnerHTML={{ __html: body }} /> : <p className="muted pr-body">No description.</p>}
        <h3 className="pr-section">Files changed {files ? `· ${files.length}` : ''}</h3>
        {!files ? <p className="muted">Loading…</p> : files.map(file => <details key={file.filename} className="pr-file" open={files.length <= 6}>
          <summary><span className="pr-file-name">{file.filename}</span><span className="pr-stat"><b className="is-add">+{file.additions}</b> <b className="is-del">−{file.deletions}</b> · {file.status}</span></summary>
          {file.patch ? <PatchView patch={file.patch} /> : <p className="muted">No text diff (binary or too large).</p>}
        </details>)}
        <h3 className="pr-section">Conversation {comments ? `· ${comments.length}` : ''}</h3>
        {comments?.map(comment => <div key={comment.id} className="pr-comment"><p className="muted">{comment.user.login} · {relativeTime(Date.parse(comment.created_at))}</p><div className="doc-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }} /></div>)}
        <div className="pr-reply">
          <textarea className="field" rows={3} placeholder="Leave a comment" value={reply} onChange={event => setReply(event.target.value)} />
          <button className="text-btn primary" disabled={busy || !reply.trim()} onClick={() => { void send() }}>Comment</button>
        </div>
      </div>}
    </div>
  </>
}
