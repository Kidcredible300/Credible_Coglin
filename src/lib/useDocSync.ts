import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type { NoteDoc } from '@/types';
import { Unauthenticated } from '@/lib/api';

/**
 * The write path for a note document.
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
 *
 * Adapted from the block-editor version rather than rewritten, because every
 * constant in it was earned. Four things changed:
 *
 *   1. The draft key. An old block-shaped draft handed to editor.setContent
 *      throws, so reusing the key would turn a parachute into a crash.
 *   2. `pending` holds a GETTER, not a value. editor.getJSON() serialises the
 *      whole document, and calling it per keystroke on a 200KB note on a school
 *      Chromebook is measurable. The cost is that the draft is written inside
 *      flush rather than per keystroke, widening the parachute window from one
 *      keystroke to the debounce — still before any request is attempted, so the
 *      "nothing to race" guarantee holds, and both scenarios it exists for
 *      (wifi dying, session expiring) survive intact.
 *   3. `baseRev` is adopted from every response. Forgetting that makes the
 *      SECOND save conflict with the first, which is the likeliest bug here.
 *   4. A 'conflict' status that is NOT retryable. Retrying a stale write forever
 *      is the failure mode, so it leaves the loop and asks the person instead.
 */

export type SyncStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

export interface SyncState {
  status: SyncStatus;
  savedAt: number | null;
  /** The server's copy, when a save lost a race. Only set on 'conflict'. */
  conflict: NoteDoc | null;
  /** Set while retrying, so the UI can say "not saved" and mean it. */
  failedSince: number | null;
}

/** Text keystrokes wait for a pause. Everything structural goes immediately. */
const TEXT_DEBOUNCE_MS = 600;
/** A fast typist still gets checkpoints rather than one enormous save at the end. */
const MAX_WAIT_MS = 5000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

const draftKey = (docId: string) => `coglin:note-draft:${docId}`;
/** Old drafts are noise, and localStorage is a small shared budget. */
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

interface Draft {
  savedAt: number;
  /** ProseMirror JSON, as a string. Never image bytes — see writeDraft. */
  content: string;
  rev: number;
}

/**
 * Read a local draft newer than the server's copy.
 *
 * This is the parachute for the two things that actually lose a student's
 * notes: the wifi dying mid-meeting, and a session expiring while they type.
 * The draft is written before any request is attempted, so there is nothing to
 * race.
 */
export function readDraft(docId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(docId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft;
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftKey(docId));
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearDraft(docId: string): void {
  try {
    localStorage.removeItem(draftKey(docId));
  } catch {
    // A full or disabled localStorage must never break note-taking.
  }
}

function writeDraft(docId: string, content: string, rev: number): void {
  try {
    // Image bytes are NEVER stored here. Two phone photos as data URLs blow the
    // 5MB quota, and then every subsequent draft write throws — turning the
    // safety net into the thing that drops the notes. The editor's image node
    // stores a media id rather than base64 for exactly this reason, and
    // allowBase64 is off so it cannot start.
    localStorage.setItem(
      draftKey(docId),
      JSON.stringify({ savedAt: Date.now(), content, rev } satisfies Draft),
    );
  } catch {
    // Out of quota or private mode. Losing the parachute is survivable; losing
    // the keystroke that triggered it is not.
  }
}

export function useDocSync(docId: string, canWrite: boolean) {
  const [state, setState] = useState<SyncState>({
    status: 'idle',
    savedAt: null,
    conflict: null,
    failedSince: null,
  });

  /**
   * A getter, not a value. See point 2 in the header: serialising the document
   * once per SAVE instead of once per keystroke is the difference between a
   * responsive editor and a laggy one on the hardware students actually have.
   */
  const pending = useRef<(() => string) | null>(null);
  const baseRev = useRef<number | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Adopt the rev the server last gave us. Call this after the initial load. */
  const setBaseRev = useCallback((rev: number) => {
    baseRev.current = rev;
  }, []);

  const flush = useCallback(async () => {
    if (!canWrite) return;
    if (inFlight.current) return;
    const get = pending.current;
    if (!get) return;

    const content = get();
    pending.current = null;
    inFlight.current = true;
    setState((s) => ({ ...s, status: 'saving' }));
    // Written here rather than on every keystroke, and still before the request
    // — so the "nothing to race" guarantee holds.
    writeDraft(docId, content, baseRev.current ?? 0);

    try {
      const result = await api.putDocContent(
        docId,
        content,
        baseRev.current ?? undefined,
      );
      // Adopting this is not optional: without it the next save carries a stale
      // base and conflicts with our own previous write.
      baseRev.current = result.doc.rev;
      attempt.current = 0;
      clearDraft(docId);
      setState({
        status: 'saved',
        savedAt: Date.now(),
        conflict: null,
        failedSince: null,
      });
    } catch (error) {
      // A 401 has already told SessionProvider, which will send the user to
      // login. The draft is on disk, so the notes survive the round trip.
      if (error instanceof Unauthenticated) {
        setState((s) => ({
          ...s,
          status: 'failed',
          failedSince: s.failedSince ?? Date.now(),
        }));
        inFlight.current = false;
        return;
      }

      /**
       * A conflict LEAVES the retry loop.
       *
       * Retrying a stale write forever is the failure mode: the base rev will
       * never match again, so every attempt fails identically while the student
       * watches "Saving…" and believes their notes are safe. The work stays in
       * `pending` and on disk, and the screen asks which copy wins.
       */
      if (error instanceof Error && error.message === 'stale_content') {
        pending.current = get;
        setState((s) => ({
          status: 'conflict',
          savedAt: s.savedAt,
          conflict: null,
          failedSince: s.failedSince ?? Date.now(),
        }));
        inFlight.current = false;
        return;
      }

      // Put the work back and try again. Ops are never dropped.
      pending.current = get;
      setState((s) => ({
        status: 'failed',
        savedAt: s.savedAt,
        conflict: null,
        failedSince: s.failedSince ?? Date.now(),
      }));
      const wait = RETRY_MS[Math.min(attempt.current, RETRY_MS.length - 1)];
      attempt.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), wait);
    } finally {
      inFlight.current = false;
    }
  }, [docId, canWrite]);

  /**
   * Hand the current document to the queue.
   *
   * `immediate` is for structural changes and, importantly, for flags: a flag
   * sitting in a 600ms debounce feels like it did not register, and the whole
   * premise of the affordance is one confident tap.
   */
  const enqueue = useCallback(
    (get: () => string, immediate = false) => {
      if (!canWrite) return;
      pending.current = get;

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
    [canWrite, flush],
  );

  /** Save now — used on blur and when the page is going away. */
  const flushNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  /**
   * Resolve a conflict by taking the server's rev as the new base and writing
   * over it. The person asked for this, having been shown what they would lose.
   */
  const keepMine = useCallback(
    (serverRev: number) => {
      baseRev.current = serverRev;
      setState((s) => ({ ...s, status: 'saving', conflict: null }));
      void flush();
    },
    [flush],
  );

  /** Drop our pending work in favour of the server's copy. */
  const discardMine = useCallback((serverRev: number) => {
    pending.current = null;
    baseRev.current = serverRev;
    clearDraft(docId);
    setState({
      status: 'saved',
      savedAt: Date.now(),
      conflict: null,
      failedSince: null,
    });
  }, [docId]);

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

  return { state, enqueue, flushNow, setBaseRev, keepMine, discardMine };
}
