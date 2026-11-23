// In-app updates: Still checks GitHub for a newer signed build, downloads it and restarts.
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { desktop } from './bridge'

export type { Update }

/** The newer build, or null when this copy is up to date. */
export async function findUpdate(): Promise<Update | null> {
  if (!desktop) return null
  return await check()
}

/** Downloads and installs the update, reporting progress from 0 to 1, then restarts Still. */
export async function installUpdate(update: Update, progress: (share: number) => void) {
  let total = 0, done = 0
  await update.downloadAndInstall(event => {
    if (event.event === 'Started') total = event.data.contentLength ?? 0
    if (event.event === 'Progress') { done += event.data.chunkLength; if (total) progress(Math.min(1, done / total)) }
    if (event.event === 'Finished') progress(1)
  })
  await relaunch()
}
