import type { ChildProcess } from 'node:child_process';

/**
 * Send SIGTERM, then escalate to SIGKILL after `escalateMs` if the process
 * has not exited. Returns immediately — the caller's settle path already
 * handles the eventual `close` event.
 */
export function killSubprocess(proc: ChildProcess, escalateMs = 2000): void {
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already exited */
  }
  const t = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }, escalateMs);
  t.unref?.();
  proc.once('close', () => clearTimeout(t));
}
