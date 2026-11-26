// Three-way merge: your version on the left, the incoming one on the right, and the result in the
// middle, where each conflict has its own Accept bar. Mark as resolved stages the file.
import { useEffect, useState } from 'react'
import { history as git } from './bridge'
import Editor, { type EditorOptions } from './Editor'

const conflictPattern = /^<<<<<<< [^\n]*\n([\s\S]*?)(?:^\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?)?^=======[^\n]*\n([\s\S]*?)^>>>>>>> [^\n]*(?:\n|$)/gm

export const conflictCount = (text: string) => (text.match(/^<<<<<<< /gm) ?? []).length
/** Every conflict resolved the same way: keep yours, theirs, or both (yours first). */
export function resolveAll(text: string, keep: 'current' | 'incoming' | 'both') {
  return text.replace(conflictPattern, (_match, current: string, incoming: string) => keep === 'current' ? current : keep === 'incoming' ? incoming : current + incoming)
}

export function MergeEditor({ rootPath, path, text, editorOptions, onChange, onResolved }: {
  rootPath: string; path: string; text: string; editorOptions: EditorOptions
  onChange: (text: string) => void; onResolved: () => void
}) {
  const [sides, setSides] = useState<{ current: string; incoming: string } | null>(null)
  useEffect(() => {
    let live = true
    // Stage 2 is your side of the merge, stage 3 the incoming one.
    void Promise.all([git.showAt(rootPath, ':2', path).catch(() => ''), git.showAt(rootPath, ':3', path).catch(() => '')])
      .then(([current, incoming]) => { if (live) setSides({ current, incoming }) })
    return () => { live = false }
  }, [rootPath, path])
  const left = conflictCount(text)
  const readOnly = { ...editorOptions, lineNumbers: true }
  return <div className="merge">
    <header className="merge-head">
      <b>{path}</b>
      <span className={'merge-count' + (left ? ' is-open' : '')}>{left ? left + (left === 1 ? ' conflict left' : ' conflicts left') : 'No conflicts left'}</span>
      <span className="flex-1" />
      <button className="text-btn" disabled={!left} onClick={() => onChange(resolveAll(text, 'current'))}>Take all yours</button>
      <button className="text-btn" disabled={!left} onClick={() => onChange(resolveAll(text, 'incoming'))}>Take all incoming</button>
      <button className="text-btn primary" disabled={left > 0} onClick={onResolved} title={left ? 'Resolve every conflict first' : 'Save and stage the file'}>Mark as resolved</button>
    </header>
    <div className="merge-columns">
      <section className="merge-column">
        <h3>Yours <span className="muted">(current branch)</span></h3>
        <div className="merge-editor">{sides ? <Editor key={'mine' + path} path={path} text={sides.current} options={readOnly} diagnostics={[]} readOnly onEdit={() => {}} onCursor={() => {}} handle={() => {}} /> : <p className="full-empty">Loading…</p>}</div>
      </section>
      <section className="merge-column is-result">
        <h3>Result <span className="muted">(edit freely; each conflict has Accept buttons)</span></h3>
        <div className="merge-editor"><Editor key={'result' + path} path={path} text={text} options={editorOptions} diagnostics={[]} onEdit={onChange} onCursor={() => {}} handle={() => {}} /></div>
      </section>
      <section className="merge-column">
        <h3>Incoming <span className="muted">(being merged in)</span></h3>
        <div className="merge-editor">{sides ? <Editor key={'theirs' + path} path={path} text={sides.incoming} options={readOnly} diagnostics={[]} readOnly onEdit={() => {}} onCursor={() => {}} handle={() => {}} /> : <p className="full-empty">Loading…</p>}</div>
      </section>
    </div>
    {!left && <p className="merge-done">All conflicts are resolved. Mark as resolved saves the file and stages it, ready to commit.</p>}
    {sides && !sides.current && !sides.incoming && <p className="merge-done">Git has no merge versions for this file (it isn't in a merge right now); the result shows the file as it is.</p>}
  </div>
}
