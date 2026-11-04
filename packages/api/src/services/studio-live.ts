/**
 * The capture studio's live wire.
 *
 * Everything that has to be fast — the picture of the page, the pointer, the
 * scroll wheel, the nudge that tells a waiting worker a command has arrived —
 * travels through this in-process relay rather than through Postgres. The
 * database keeps what must survive: the session row, the command log, and a
 * frame every couple of seconds so a viewer arriving after a restart still
 * sees something.
 *
 *   worker --POST frame-->  relay  --multipart stream-->  studio <img>
 *   studio --POST input-->  relay  --long poll-------->  worker
 *
 * Why this is safe to keep in memory
 * ----------------------------------
 * Both halves already live in the CMS process: the worker's control-plane API
 * is mounted there, and so are the studio's routes. Nothing here is the record
 * of anything — losing it on a restart costs one stale frame and a pointer
 * position, and every path below falls back to the database when the relay
 * has nothing. A second CMS instance would need a shared relay (Redis
 * pub/sub, say); until then, one instance is the supported deployment for the
 * live view.
 *
 * Stored on `globalThis` under a registered symbol, because a Next.js dev
 * server reloads modules and may bundle the same package into several route
 * handlers. All of those copies have to find the same relay, or the worker
 * would post frames into one and the studio would read from another.
 */

export interface LiveFrame {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
  readonly at: number;
}

/**
 * Pointer and wheel input. Ephemeral by design: only the latest pointer
 * position matters, and wheel deltas are summed, so a fast hand produces one
 * instruction per worker turn instead of a queue of stale ones.
 */
export interface LiveInput {
  readonly pointer: { readonly x: number; readonly y: number } | null;
  readonly wheel: {
    readonly x: number;
    readonly y: number;
    readonly deltaX: number;
    readonly deltaY: number;
  } | null;
}

type FrameListener = (frame: LiveFrame) => void;

interface SessionChannel {
  frame: LiveFrame | null;
  seq: number;
  persistedAt: number;
  listeners: Set<FrameListener>;
  commandWaiters: Set<() => void>;
  inputWaiters: Set<() => void>;
  endListeners: Set<() => void>;
  pointer: { x: number; y: number } | null;
  wheel: { x: number; y: number; deltaX: number; deltaY: number } | null;
  lease: { token: string; verifiedAt: number } | null;
  ended: boolean;
}

interface Relay {
  readonly sessions: Map<string, SessionChannel>;
}

const RELAY_KEY = Symbol.for("uxd.studio.live-relay");

function relay(): Relay {
  const holder = globalThis as typeof globalThis & { [RELAY_KEY]?: Relay };
  holder[RELAY_KEY] ??= { sessions: new Map() };
  return holder[RELAY_KEY];
}

function channel(sessionId: string): SessionChannel {
  const sessions = relay().sessions;
  let found = sessions.get(sessionId);
  if (!found) {
    found = {
      frame: null,
      seq: 0,
      persistedAt: 0,
      listeners: new Set(),
      commandWaiters: new Set(),
      inputWaiters: new Set(),
      endListeners: new Set(),
      pointer: null,
      wheel: null,
      lease: null,
      ended: false,
    };
    sessions.set(sessionId, found);
  }
  return found;
}

/**
 * Resolve after `ms`, or as soon as `waiters` is woken — whichever is first.
 * The waiter is always removed, so an abandoned long poll leaves nothing
 * behind.
 */
function waitOn(waiters: Set<() => void>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function wake(waiters: Set<() => void>): void {
  for (const waiter of [...waiters]) waiter();
}

// --- Frames ---------------------------------------------------------------

/**
 * Publish a frame from the worker. Returns whether the caller should also
 * write it to the database — true at most once per `persistEveryMs`, so the
 * database sees a frame every couple of seconds instead of every one.
 */
export function publishLiveFrame(
  sessionId: string,
  frame: { bytes: Uint8Array; width: number; height: number },
  persistEveryMs: number,
): { seq: number; persist: boolean } {
  const live = channel(sessionId);
  if (live.ended) return { seq: live.seq, persist: false };

  live.seq += 1;
  const now = Date.now();
  const published: LiveFrame = { ...frame, seq: live.seq, at: now };
  live.frame = published;
  for (const listener of [...live.listeners]) {
    try {
      listener(published);
    } catch {
      // A viewer whose stream broke mid-write is removed by its own cleanup.
      // One bad listener must never stop the others from getting the frame.
    }
  }

  const persist = now - live.persistedAt >= persistEveryMs;
  if (persist) live.persistedAt = now;
  return { seq: live.seq, persist };
}

export function latestLiveFrame(sessionId: string): LiveFrame | null {
  return relay().sessions.get(sessionId)?.frame ?? null;
}

/**
 * Listen for frames, and for the session ending. Returns the unsubscribe.
 */
export function subscribeLiveFrames(
  sessionId: string,
  listener: FrameListener,
  onEnd: () => void,
): () => void {
  const live = channel(sessionId);
  live.listeners.add(listener);
  live.endListeners.add(onEnd);
  return () => {
    live.listeners.delete(listener);
    live.endListeners.delete(onEnd);
  };
}

export function liveViewerCount(sessionId: string): number {
  return relay().sessions.get(sessionId)?.listeners.size ?? 0;
}

// --- Commands -------------------------------------------------------------

/** A command row was written: wake the worker's long poll now. */
export function notifyLiveCommand(sessionId: string): void {
  const live = relay().sessions.get(sessionId);
  if (live) wake(live.commandWaiters);
}

/** Wait for `notifyLiveCommand`, or `ms`, or the request going away. */
export function waitForLiveCommand(sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
  return waitOn(channel(sessionId).commandWaiters, ms, signal);
}

// --- Pointer and wheel ----------------------------------------------------

export function pushLivePointer(sessionId: string, x: number, y: number): void {
  const live = channel(sessionId);
  if (live.ended) return;
  live.pointer = { x, y };
  wake(live.inputWaiters);
}

export function pushLiveWheel(
  sessionId: string,
  wheel: { x: number; y: number; deltaX: number; deltaY: number },
): void {
  const live = channel(sessionId);
  if (live.ended) return;
  const clamp = (value: number) => Math.max(-20_000, Math.min(20_000, value));
  live.wheel = live.wheel
    ? {
        x: wheel.x,
        y: wheel.y,
        deltaX: clamp(live.wheel.deltaX + wheel.deltaX),
        deltaY: clamp(live.wheel.deltaY + wheel.deltaY),
      }
    : { ...wheel };
  wake(live.inputWaiters);
}

/**
 * Hand the worker whatever pointer and wheel input has accumulated, waiting up
 * to `ms` for some to arrive. Taking it clears it.
 */
export async function takeLiveInput(
  sessionId: string,
  ms: number,
  signal?: AbortSignal,
): Promise<LiveInput & { ended: boolean }> {
  const live = channel(sessionId);
  if (!live.pointer && !live.wheel && !live.ended) {
    await waitOn(live.inputWaiters, ms, signal);
  }
  const taken = { pointer: live.pointer, wheel: live.wheel, ended: live.ended };
  live.pointer = null;
  live.wheel = null;
  return taken;
}

// --- Lease ----------------------------------------------------------------

/**
 * Remember a lease the database just confirmed, so frames and input polls —
 * many a second — can be checked without a query each.
 */
export function rememberLiveLease(sessionId: string, token: string): void {
  const live = channel(sessionId);
  live.ended = false;
  live.lease = { token, verifiedAt: Date.now() };
}

/**
 * Whether `token` is the session's lease, as of at most `maxAgeMs` ago. A
 * `false` here means "ask the database", not "refuse": the cache may simply be
 * cold after a restart.
 */
export function liveLeaseIsFresh(sessionId: string, token: string, maxAgeMs: number): boolean {
  const lease = relay().sessions.get(sessionId)?.lease;
  return lease !== null && lease !== undefined && lease.token === token && Date.now() - lease.verifiedAt < maxAgeMs;
}

/**
 * The session is over. Wake everything still waiting on it, close every
 * viewer's stream, and forget the frame — the browser behind it is gone.
 */
export function endLiveSession(sessionId: string): void {
  const live = relay().sessions.get(sessionId);
  if (!live) return;
  live.ended = true;
  live.lease = null;
  live.frame = null;
  live.pointer = null;
  live.wheel = null;
  wake(live.commandWaiters);
  wake(live.inputWaiters);
  for (const listener of [...live.endListeners]) listener();
  relay().sessions.delete(sessionId);
}
