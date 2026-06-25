/**
 * poll Trigger (PULL via interval).
 *
 * The simplest possible Trigger: no external nudge, just re-check the bus every
 * `ms`. It proves the port is real and works where filesystem events don't
 * (some network filesystems, exotic sandboxes). Slower to react than file-watch,
 * but zero moving parts. Select it with AGENTBUS_TRIGGER=poll.
 */
import type { Trigger } from '../core/ports'

export function pollTrigger(ms: number): Trigger {
  return {
    arm(_self, onWake) {
      const t = setInterval(onWake, ms)
      return () => clearInterval(t)
    },
    notify() {}, // pollers find their own mail on the next tick
  }
}
