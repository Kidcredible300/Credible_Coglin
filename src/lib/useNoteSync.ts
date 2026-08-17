import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api';
import { Unauthenticated } from '@/lib/api';
import type { DraftBlock } from '@/lib/notes';

/**
 * The write path for meeting notes.
 *
 * Deliberately NOT `useAsync`. That hook models a read that restarts when its
 * deps change and throws away what it had — exactly wrong here, where local
 * state is authoritative, edits are ordered, and a failure has to be retried
 * rather than rendered. `useAsync` still does the initial load; this owns
 * everything after it.
 *
 * It is also not a reason to add a query library. TanStack Query is a
 * server-state cache — dedupe, invalidation, background refetch. This is an
 * offline-tolerant ordered write queue where the server is a durable log. The
 * `useAsync` comment declining a query library "until there are real requests,
 * real invalidation and real polling" is still true; when a second student's
 * edits need to appear live, the answer is a websocket into the same reducer
 * (the Durable Object already on the roadmap), not a polling cache.
 */

export type SyncStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface SyncState {
  status: SyncStatus;
  savedAt: number | null;
  /** Set while retrying, so the UI can say "not saved" and mean it. */
  failedSince: number | null;
}

/** Text keystrokes wait for a pause. Everything structural goes immediately. */
const TEXT_DEBOUNCE_MS = 600;
/** A fast typist still gets checkpoints rather than one enormous save at the end. */
const MAX_WAIT_MS = 5000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

const draftKey = (meetingId: string) => `coglin:meeting-draft:${meetingId}`;
/** Old drafts are noise, and localStorage is a small shared budget. */
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

interface Draft {
  savedAt: number;
  blocks: DraftBlock[];
}

/**
 * Read a local draft newer than the server's copy.
 *
 * This is the parachute for the two things that actually lose a student's
 * notes: the wifi dying mid-meeting, and a session expiring while they type.
 * The draft is written before any request is attempted, so there is nothing to
 * race.
 */
export function readDraft(meetingId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(meetingId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft;
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftKey(meetingId));
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearDraft(meetingId: string): void {
  try {
    localStorage.removeItem(draftKey(meetingId));
  } catch {
    // A full or disabled localStorage must never break note-taking.
  }
}

function writeDraft(meetingId: string, blocks: DraftBlock[]): void {
  try {
    // Image bytes are NEVER stored here. Two phone photos as data URLs blow the
    // 5MB quota, and then every subsequent draft write throws — turning the
    // safety net into the thing that drops the notes.
    localStorage.setItem(
      draftKey(meetingId),
      JSON.stringify({ savedAt: Date.now(), blocks } satisfies Draft),
    );
  } catch {
    // Out of quota or private mode. Losing the parachute is survivable; losing
    // the keystroke that triggered it is not.
  }
}

export function useNoteSync(meetingId: string, canWrite: boolean) {
  const [state, setState] = useState<SyncState>({
    status: 'idle',
    savedAt: null,
    failedSince: null,
  });

  /** The document as last handed to us. A ref, so timers always see the latest. */
  const pending = useRef<DraftBlock[] | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (!canWrite) return;
    if (inFlight.current) return;
    const blocks = pending.current;
    if (!blocks) return;

    pending.current = null;
    inFlight.current = true;
    setState((s) => ({ ...s, status: 'saving' }));

    try {
      // One structural write for the whole document. It is idempotent, it
      // renormalises positions, and it is the only shape that stays correct
      // when a split, a merge and three edits all happened since the last save.
      await api.replaceBlocks(
        meetingId,
        blocks.map((b) => ({
          id: b.id,
          kind: b.kind,
          text: b.text,
          media_id: b.media_id,
        })),
      );
      attempt.current = 0;
      clearDraft(meetingId);
      setState({ status: 'saved', savedAt: Date.now(), failedSince: null });
    } catch (error) {
      // A 401 has already told SessionProvider, which will send the user to
      // login. The draft is on disk, so the notes survive the round trip.
      if (error instanceof Unauthenticated) {
        setState((s) => ({ ...s, status: 'failed', failedSince: s.failedSince ?? Date.now() }));
        inFlight.current = false;
        return;
      }

      // Put the work back and try again. Ops are never dropped.
      pending.current = blocks;
      writeDraft(meetingId, blocks);
      setState((s) => ({
        status: 'failed',
        savedAt: s.savedAt,
        failedSince: s.failedSince ?? Date.now(),
      }));
      const wait = RETRY_MS[Math.min(attempt.current, RETRY_MS.length - 1)];
      attempt.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), wait);
    } finally {
      inFlight.current = false;
    }
  }, [meetingId, canWrite]);

  /**
   * Hand the current document to the queue.
   *
   * `immediate` is for structural changes and, importantly, for flags: a flag
   * sitting in a 600ms debounce feels like it did not register, and the whole
   * premise of the affordance is one confident tap.
   */
  const enqueue = useCallback(
    (blocks: DraftBlock[], immediate = false) => {
      if (!canWrite) return;
      pending.current = blocks;
      writeDraft(meetingId, blocks);

      if (timer.current) clearTimeout(timer.current);
      if (immediate) {
        if (maxWaitTimer.current) {
          clearTimeout(maxWaitTimer.current);
          maxWaitTimer.current = null;
        }
        void flush();
        return;
      }

      timer.current = setTimeout(() => void flush(), TEXT_DEBOUNCE_MS);
      // A student typing without pause would otherwise never checkpoint.
      if (!maxWaitTimer.current) {
        maxWaitTimer.current = setTimeout(() => {
          maxWaitTimer.current = null;
          void flush();
        }, MAX_WAIT_MS);
      }
    },
    [meetingId, canWrite, flush],
  );

  /** Save now — used on blur and when the page is going away. */
  const flushNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  useEffect(() => {
    const onHidden = () => {
      // Not beforeunload: iOS Safari does not fire it reliably, and a phone
      // being locked mid-meeting is the common case, not a closed tab.
      if (document.visibilityState === 'hidden') flushNow();
    };
    const onOnline = () => flushNow();

    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('online', onOnline);
      if (timer.current) clearTimeout(timer.current);
      if (maxWaitTimer.current) clearTimeout(maxWaitTimer.current);
    };
  }, [flushNow]);

  return { state, enqueue, flushNow };
}
