import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, BookmarkCheck, Check, Copy, MapPin } from 'lucide-react';
import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import { formatLongDate, formatTime, relativeDays } from '@/lib/format';
import { clearDraft, readDraft, useNoteSync } from '@/lib/useNoteSync';
import { newBlock, toDraft, toPlainText, type DraftBlock } from '@/lib/notes';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NoteEditor } from '@/components/notes/NoteEditor';
import { AttendancePanel } from '@/components/meetings/AttendancePanel';
import { MEETING_KINDS, type AttendanceRecord } from '@/types';

const KIND_LABEL = new Map(MEETING_KINDS.map((k) => [k.id, k.label]));

/**
 * Save state as one quiet line, not a toast.
 *
 * Every message here is a persistent STATE — saved, saving, not saved — and a
 * toast that disappears while the wifi is still down is a lie. On a phone it
 * would also land under the tab bar and the keyboard.
 */
function SaveIndicator({
  status,
  savedAt,
  onRetry,
}: {
  status: 'idle' | 'saving' | 'saved' | 'failed';
  savedAt: number | null;
  onRetry: () => void;
}) {
  if (status === 'failed') {
    return (
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
      >
        <span>Not saved — retrying.</span>
        <button
          type="button"
          onClick={onRetry}
          className="focus-visible:ring-ring min-h-11 font-medium underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Retry now
        </button>
      </div>
    );
  }
  return (
    <p aria-live="polite" className="text-muted-foreground text-xs">
      {status === 'saving' && 'Saving…'}
      {status === 'saved' && savedAt && `Saved · ${formatTime(Math.floor(savedAt / 1000))}`}
      {status === 'idle' && ' '}
    </p>
  );
}

export default function Meeting() {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const detail = useAsync(
    () => api.getMeeting(meetingId as string),
    [meetingId, reloadKey],
  );
  const members = useAsync(api.listMembers);
  const { member } = useSession();
  const canEdit = member.role !== 'viewer';
  const canManage = member.role === 'coach' || member.role === 'mentor';
  const now = api.now();

  const [blocks, setBlocks] = useState<DraftBlock[]>([]);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [draftOffer, setDraftOffer] = useState<DraftBlock[] | null>(null);
  const [copied, setCopied] = useState(false);

  const { state: sync, enqueue, flushNow } = useNoteSync(meetingId as string, canEdit);

  /**
   * Seed local state from the server once, then own it.
   *
   * Same shape as Boards.tsx: the fetch is the starting point, not a
   * subscription. Anything else and a debounced save would fight the refetch it
   * triggered.
   */
  useEffect(() => {
    if (!detail.data) return;
    const server = detail.data.blocks.map(toDraft);
    setBlocks(server.length > 0 ? server : [newBlock()]);
    setFlaggedIds(
      new Set(
        detail.data.candidates
          .filter((c) => c.source_type === 'meeting_block')
          .map((c) => c.source_id),
      ),
    );

    // A draft newer than the server's copy means the last session ended badly —
    // wifi died, or a session expired mid-sentence. Offer it rather than
    // silently picking a side.
    const draft = readDraft(meetingId as string);
    const newest = detail.data.blocks.reduce((max, b) => Math.max(max, b.updated_at), 0);
    if (draft && draft.savedAt > newest * 1000) setDraftOffer(draft.blocks);
  }, [detail.data, meetingId]);

  const meetingFlagged = useMemo(
    () =>
      (detail.data?.candidates ?? []).some(
        (c) => c.source_type === 'meeting' && c.source_id === meetingId,
      ),
    [detail.data, meetingId],
  );
  const [wholeFlagged, setWholeFlagged] = useState(false);
  useEffect(() => setWholeFlagged(meetingFlagged), [meetingFlagged]);

  const onEditorChange = useCallback(
    (next: DraftBlock[], immediate: boolean) => {
      setBlocks(next);
      enqueue(next, immediate);
    },
    [enqueue],
  );

  /**
   * Toggle a flag.
   *
   * Optimistic, and flushed immediately rather than debounced: a mark that sits
   * in a 600ms wait feels like it did not register, and the whole premise of the
   * affordance is one confident tap. The block is saved first so the server has
   * a row to attach the flag to.
   */
  const onToggleFlag = useCallback(
    async (block: DraftBlock) => {
      const wasFlagged = flaggedIds.has(block.id);
      setFlaggedIds((prev) => {
        const next = new Set(prev);
        if (wasFlagged) next.delete(block.id);
        else next.add(block.id);
        return next;
      });

      try {
        if (wasFlagged) {
          await api.unflagCandidate('meeting_block', block.id);
        } else {
          flushNow();
          await api.flagCandidate({
            source_type: 'meeting_block',
            source_id: block.id,
          });
        }
      } catch {
        // Put the mark back where it was. A flag that looks applied but is not
        // is worse than one that visibly failed, because nobody checks in March.
        setFlaggedIds((prev) => {
          const next = new Set(prev);
          if (wasFlagged) next.add(block.id);
          else next.delete(block.id);
          return next;
        });
      }
    },
    [flaggedIds, flushNow],
  );

  async function onToggleWholeMeeting() {
    const was = wholeFlagged;
    setWholeFlagged(!was);
    try {
      if (was) await api.unflagCandidate('meeting', meetingId as string);
      else
        await api.flagCandidate({
          source_type: 'meeting',
          source_id: meetingId as string,
        });
    } catch {
      setWholeFlagged(was);
    }
  }

  async function onStart() {
    await api.startMeeting(meetingId as string);
    setReloadKey((k) => k + 1);
  }

  async function onCopy() {
    await navigator.clipboard.writeText(toPlainText(blocks));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (detail.status === 'loading') {
    return (
      <div className="space-y-4 px-4 py-6 md:px-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (detail.status === 'error' || !detail.data) {
    return (
      <div className="px-4 py-6 md:px-8">
        <EmptyState
          title="That meeting is not here."
          aside="It may have been deleted, or it belongs to another team."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate('/meetings')}>
              Back to meetings
            </Button>
          }
        />
      </div>
    );
  }

  const { meeting, agenda } = detail.data;
  const attendance = detail.data.attendance as AttendanceRecord[];
  const cancelled = meeting.status === 'cancelled';
  const started = meeting.started_at !== null;
  const flaggedCount = flaggedIds.size + (wholeFlagged ? 1 : 0);

  return (
    <>
      <div className="border-border border-b px-4 py-5 md:px-8">
        <Link
          to="/meetings"
          className="text-muted-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Meetings
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="u-display text-heading text-2xl">{meeting.title}</h1>
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span>{formatLongDate(meeting.starts_at)}</span>
              <span className="tabular font-mono">
                {formatTime(meeting.starts_at)}
                {meeting.ends_at ? `–${formatTime(meeting.ends_at)}` : ''}
              </span>
              <span>{relativeDays(meeting.starts_at, now)}</span>
              {meeting.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" aria-hidden />
                  {meeting.location}
                </span>
              )}
              <Badge variant="secondary">{KIND_LABEL.get(meeting.kind)}</Badge>
              {cancelled && <Badge variant="outline">Cancelled</Badge>}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Zero renders nothing: "0 flagged" is a scolding, not information. */}
            {flaggedCount > 0 && (
              <Link
                to="/portfolio"
                className="text-primary-ink focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 focus-visible:ring-2 focus-visible:outline-none"
              >
                <BookmarkCheck className="size-4" aria-hidden />
                <span className="tabular font-mono text-sm">{flaggedCount}</span>
                <span className="u-eyebrow">flagged</span>
              </Link>
            )}

            {canEdit && !started && !cancelled && (
              <Button size="sm" onClick={() => void onStart()}>
                Start meeting
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void onCopy()}>
                  {copied ? (
                    <>
                      <Check className="size-4" aria-hidden /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" aria-hidden /> Copy notes
                    </>
                  )}
                </DropdownMenuItem>
                {canEdit && (
                  <DropdownMenuItem onSelect={() => void onToggleWholeMeeting()}>
                    {wholeFlagged
                      ? 'Remove portfolio flag'
                      : 'Flag this whole meeting'}
                  </DropdownMenuItem>
                )}
                {canManage && !cancelled && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      void api
                        .cancelMeeting(meeting.id)
                        .then(() => setReloadKey((k) => k + 1))
                    }
                  >
                    Cancel meeting
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-4 py-6 md:px-8">
        {draftOffer && (
          <div
            role="alert"
            className="border-primary/40 bg-primary/5 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <span>You have unsaved notes from this device.</span>
            <Button
              size="xs"
              onClick={() => {
                setBlocks(draftOffer);
                enqueue(draftOffer, true);
                setDraftOffer(null);
              }}
            >
              Restore
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                clearDraft(meetingId as string);
                setDraftOffer(null);
              }}
            >
              Discard
            </Button>
          </div>
        )}

        {agenda.length > 0 && (
          <section>
            <h2 className="u-eyebrow mb-3">Agenda</h2>
            <ul className="bg-card border-border divide-border divide-y rounded-lg border">
              {agenda.map((item) => (
                <li key={item.id} className="px-4 py-3 text-sm">
                  {item.title}
                  {item.minutes_planned && (
                    <span className="text-muted-foreground tabular ml-2 font-mono text-xs">
                      {item.minutes_planned}m
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="u-eyebrow mb-3">Who was here</h2>
          {members.data && (
            <AttendancePanel
              meetingId={meeting.id}
              members={members.data}
              attendance={attendance}
              canRecord={canManage}
              selfMemberId={member.id}
              onSaved={() => setReloadKey((k) => k + 1)}
            />
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="u-eyebrow">Notes</h2>
            <SaveIndicator
              status={sync.status}
              savedAt={sync.savedAt}
              onRetry={flushNow}
            />
          </div>

          <div className="bg-card border-border rounded-lg border px-2 py-3 md:px-4">
            <NoteEditor
              blocks={blocks}
              flaggedIds={flaggedIds}
              readOnly={!canEdit}
              onChange={onEditorChange}
              onToggleFlag={(block) => void onToggleFlag(block)}
            />
          </div>

          <p className="text-muted-foreground mt-3 text-xs">
            Enter starts a new line. The bookmark marks anything worth putting in
            the portfolio — you can sort out which award it belongs to later.
          </p>
        </section>
      </div>
    </>
  );
}
