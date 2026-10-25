/**
 * Single active instance. Browser tabs and the installed app share one database on
 * Android and desktop, but each window keeps its own decrypted state and live
 * connections in memory. Two active windows would drift apart and fight over
 * sessions, so only one may be unlocked at a time (the same model as WhatsApp Web).
 *
 * Implemented with the Web Locks API: the active window holds an exclusive lock, a new
 * window can `steal` it, and the previous holder is notified and steps aside.
 *
 * On iOS the Home Screen app has storage fully separate from Safari, so the lock is
 * not shared either - those are simply two independent installations.
 */

const LOCK = 'veil-active-instance';

let release: (() => void) | undefined;
let lostHandler: (() => void) | undefined;

const supported = () => typeof navigator !== 'undefined' && !!navigator.locks;

/** Is another window currently holding the active-instance lock? */
export async function heldElsewhere(): Promise<boolean> {
  if (!supported() || release) return false;
  const state = await navigator.locks.query();
  return !!state.held?.some((l) => l.name === LOCK);
}

/**
 * Become the active instance. Without `takeover` this fails if another window is
 * active; with it, the other window is asked to step aside.
 */
export function claimInstance(takeover = false): Promise<boolean> {
  if (!supported() || release) return Promise.resolve(true);
  return new Promise((resolve) => {
    const opts: LockOptions = takeover ? { steal: true } : { ifAvailable: true };
    navigator.locks
      .request(LOCK, opts, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // Hold the lock until we release it or it is stolen.
        return new Promise<void>((r) => {
          release = () => {
            release = undefined;
            r();
          };
        });
      })
      .catch(() => {
        // AbortError: another window stole the lock.
        release = undefined;
        lostHandler?.();
      });
  });
}

export function releaseInstance() {
  release?.();
}

export function onInstanceLost(handler: () => void) {
  lostHandler = handler;
}
