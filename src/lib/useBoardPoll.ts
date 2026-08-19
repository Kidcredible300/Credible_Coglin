import { useEffect, useRef } from 'react';
import * as api from '@/lib/api';
import { Unauthenticated } from '@/lib/api';
import type { Task } from '@/types';

/**
 * Keeps one board fresh while other people are working on it.
 *
 * COG-009 called for a Durable Object per team replaying the op stream. This is
 * the cheaper half of that promise, and the one README already committed to:
 * "Polling for v1; Durable Object TeamRoom in Phase 4." Nothing here is a
 * binding, a service or a bill — the whole cost is D1 row reads, and the design
 * is arranged to make that number small.
 *
 * The trick is that the tick does not fetch the board. It fetches
 * `/api/boards/:id/rev`, one aggregate row, and only asks for the task list when
 * `rev` or `count` has actually moved. A board nobody is touching therefore
 * costs one row read per client per tick and nothing else, which is what makes
 * a 10-second interval affordable for fifteen students on one board.
 *
 * Not built on `useAsync`, for the reason `useDocSync` gives: this is a
 * long-lived background loop with its own lifecycle, not a fetch-on-mount.
 */

/** Quiet enough that a card someone else moved appears while you are still looking. */
const BASE_MS = 10_000;

/**
 * Backoff for a board nobody is editing.
 *
 * A board left open overnight would otherwise poll ~8,600 times. Three
 * consecutive unchanged ticks is a good sign the meeting is over.
 */
const IDLE_MS = 30_000;
const IDLE_AFTER = 3;

export function useBoardPoll({
  boardId,
  paused,
  onTasks,
  onRev,
  knownRev,
}: {
  boardId: string | null;
  /**
   * True while a drag is in flight or a write is in the air. A poll that lands
   * mid-gesture would replace the optimistic local state with the server's
   * pre-move copy and the card would visibly snap back under the cursor.
   */
  paused: boolean;
  onTasks: (boardId: string, tasks: Task[]) => void;
  onRev: (rev: { rev: number; count: number }) => void;
  /**
   * The revision the caller already knows about, including the one it learned
   * from its own write. Read through a ref so a change does not restart the
   * timer.
   */
  knownRev: { rev: number; count: number } | null;
}): void {
  // Everything the loop reads goes through a ref, so the effect depends only on
  // the board id. Putting callbacks in the dependency list would tear down and
  // rebuild the interval on every parent render, which on a board being dragged
  // is every frame.
  const pausedRef = useRef(paused);
  const knownRef = useRef(knownRev);
  const onTasksRef = useRef(onTasks);
  const onRevRef = useRef(onRev);
  pausedRef.current = paused;
  knownRef.current = knownRev;
  onTasksRef.current = onTasks;
  onRevRef.current = onRev;

  useEffect(() => {
    if (!boardId) return;
    // Bound to a local so the async closures below get a plain string; the
    // narrowing on the prop does not survive into them.
    const id = boardId;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quietTicks = 0;

    async function tick(): Promise<void> {
      if (cancelled) return;
      // Hidden tab: a phone in a pocket mid-meeting should cost nothing. The
      // visibilitychange listener below catches it up the moment it comes back.
      if (document.visibilityState === 'hidden' || pausedRef.current) {
        schedule(BASE_MS);
        return;
      }

      try {
        const rev = await api.boardRev(id);
        if (cancelled) return;

        const known = knownRef.current;
        if (known && known.rev === rev.rev && known.count === rev.count) {
          quietTicks += 1;
          schedule(quietTicks >= IDLE_AFTER ? IDLE_MS : BASE_MS);
          return;
        }

        // Something moved. Now — and only now — pay for the task rows.
        const tasks = await api.listTasks(id);
        if (cancelled) return;
        // Re-check: the user may have started dragging during the fetch, and
        // clobbering a live gesture is exactly what `paused` exists to prevent.
        if (!pausedRef.current) {
          onTasksRef.current(id, tasks);
          onRevRef.current(rev);
        }
        quietTicks = 0;
        schedule(BASE_MS);
      } catch (err) {
        if (cancelled) return;
        // A 401 has already broadcast SESSION_EXPIRED from api.ts and the
        // provider is about to swap the whole tree for the login screen. Stop
        // rather than hammering a dead session.
        if (err instanceof Unauthenticated) return;
        // Anything else is pit wifi. Back off and keep going; a poll that gives
        // up permanently on one dropped request is worse than useless.
        schedule(IDLE_MS);
      }
    }

    function schedule(ms: number): void {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), ms);
    }

    function onVisible(): void {
      if (document.visibilityState !== 'visible') return;
      // Catch up immediately rather than waiting out the remaining interval,
      // and reset the backoff — somebody just came back to this screen.
      quietTicks = 0;
      clearTimeout(timer);
      void tick();
    }

    document.addEventListener('visibilitychange', onVisible);
    schedule(BASE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [boardId]);
}
