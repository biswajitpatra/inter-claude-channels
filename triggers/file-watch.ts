/**
 * file-watch Trigger (PULL via filesystem events).
 *
 * A per-peer zero-byte wake file under wake/. Touching wake/<peer> fires that
 * peer's fs.watch (backed by kqueue/inotify) — near-instant, no daemon, no
 * network, and none of the PID-signal hazards of SIGUSR1. The file carries no
 * data; it is purely a "go look at the bus" nudge. The bus stays the source of
 * truth, so a missed event only delays delivery until the next safety poll.
 */
import { mkdirSync, writeFileSync, watch } from 'fs'
import { join } from 'path'
import type { Trigger } from '../core/ports'

export function fileWatchTrigger(wakeDir: string): Trigger {
  mkdirSync(wakeDir, { recursive: true })
  const path = (n: string) => join(wakeDir, n)
  return {
    arm(self, onWake) {
      try { writeFileSync(path(self), '') } catch {} // ensure it exists to watch
      const w = watch(wakeDir, (_event, file) => { if (file === null || file === self) onWake() })
      return () => w.close()
    },
    notify(recipient) {
      try { writeFileSync(path(recipient), '') } catch {}
    },
  }
}
