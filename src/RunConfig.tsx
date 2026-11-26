import { useState } from 'react'
import { Modal } from './ui'

/** Arguments and environment variables for running one file (kept for the project). */
export function RunConfigDialog({ file, args, env, dotenv, onClose, onSave }: {
  file: string; args: string; env: string; dotenv: boolean
  onClose: () => void; onSave: (args: string, env: string, run: boolean) => void
}) {
  const [nextArgs, setArgs] = useState(args)
  const [nextEnv, setEnv] = useState(env)
  const badLines = nextEnv.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(line))
  return <Modal title={'Run configuration · ' + file} onClose={onClose} className="run-config">
    <label className="field-label" htmlFor="run-args">Program arguments</label>
    <input id="run-args" className="field" value={nextArgs} onChange={event => setArgs(event.target.value)} autoFocus spellCheck={false} placeholder='--verbose input.txt "two words"'
      onKeyDown={event => { if (event.key === 'Enter' && !badLines.length) onSave(nextArgs, nextEnv, true) }} />
    <label className="field-label" htmlFor="run-env">Environment variables <span className="muted">· one per line, NAME=value</span></label>
    <textarea id="run-env" className="field run-env" value={nextEnv} onChange={event => setEnv(event.target.value)} spellCheck={false} rows={5} placeholder={'DEBUG=1\nAPI_URL=http://localhost:8000'} />
    {badLines.length > 0 && <p className="field-error">Not NAME=value: {badLines[0]}</p>}
    <p className="sheet-note">{dotenv ? 'The project’s .env file is loaded too; these win where both set a name.' : 'The project’s .env file is not loaded (Settings → Projects).'} Used when you run, debug or test this file.</p>
    <div className="sheet-actions">
      <button className="paper-btn" onClick={onClose}>Cancel</button>
      <button className="paper-btn" disabled={badLines.length > 0} onClick={() => onSave(nextArgs, nextEnv, false)}>Save</button>
      <button className="paper-btn primary" disabled={badLines.length > 0} onClick={() => onSave(nextArgs, nextEnv, true)}>Save and run</button>
    </div>
  </Modal>
}
