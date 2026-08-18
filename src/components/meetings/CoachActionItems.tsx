import { useCallback, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/Skeleton';
import { isOverdue, relativeDays } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ActionItem } from '@/types';

/**
 * The coach's own to-do list for this meeting.
 *
 * "Follow up with John about his behaviour at meetings." "Pay registration."
 * "Email Jamie's mum." These are not team tasks and they are not notes — they
 * are one adult's responsibilities, some of them about a named student, and the
 * students must not see them.
 *
 * The gate is on the routes, not here. This component simply is not rendered for
 * anyone else, and if it somehow were, every fetch answers 403.
 *
 * It fetches its own data rather than reading MeetingDetail, because that
 * payload is readable by every member of the team. A role-conditional field on it
 * would hide the privacy rule from whoever edits that batch next — which is
 * exactly how these leaked in the first place.
 */

const ERROR_COPY: Record<string, string> = {
  forbidden: 'Only coaches and mentors can use this list.',
  missing_text: 'Type something first.',
  invalid_body: 'Type something first.',
  not_found: 'That item is already gone.',
};

export function CoachActionItems({ meetingId }: { meetingId: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  const items = useAsync(
    () => api.listMeetingActionItems(meetingId),
    [meetingId, reloadKey],
  );
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const now = api.now();

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const add = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      await api.createActionItem(meetingId, {
        text: trimmed,
        // A bare date means midnight local, which is what a coach means by
        // "due Friday" — the browser's zone is the one they set it in.
        due_at: due ? Math.floor(new Date(`${due}T00:00`).getTime() / 1000) : null,
      });
      setText('');
      setDue('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
    } finally {
      setPending(false);
    }
  }, [due, meetingId, reload, text]);

  const toggle = useCallback(
    async (item: ActionItem) => {
      setError(null);
      try {
        await api.updateActionItem(meetingId, item.id, {
          status: item.status === 'done' ? 'open' : 'done',
        });
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : '');
      }
    },
    [meetingId, reload],
  );

  const remove = useCallback(
    async (item: ActionItem) => {
      setError(null);
      try {
        await api.deleteActionItem(meetingId, item.id);
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : '');
      }
    },
    [meetingId, reload],
  );

  const all = items.data ?? [];
  const open = all.filter((i) => i.status !== 'done');
  const done = all.filter((i) => i.status === 'done');

  return (
    <div className="bg-card border-border overflow-hidden rounded-lg border">
      {/* Functional copy, not decoration. A coach needs to know the blast radius
          BEFORE they type something about a student, not after. If this line
          gets cut as clutter, the feature becomes a trap. */}
      <p className="text-muted-foreground border-border border-b px-4 py-2.5 text-xs">
        Only coaches and mentors can see this list.
      </p>

      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Input
          value={text}
          maxLength={500}
          placeholder="Pay registration"
          aria-label="What do you need to do?"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
          className="min-h-11 min-w-40 flex-1 md:min-h-9"
        />
        <Input
          type="date"
          value={due}
          aria-label="Due date (optional)"
          onChange={(event) => setDue(event.target.value)}
          className="min-h-11 w-40 md:min-h-9"
        />
        <Button
          size="sm"
          disabled={pending || text.trim() === ''}
          onClick={() => void add()}
        >
          <Plus className="size-4" aria-hidden />
          Add
        </Button>
      </div>

      {items.status === 'loading' ? (
        <div className="p-4">
          <Skeleton className="h-16" />
        </div>
      ) : items.status === 'error' ? (
        <p role="alert" className="text-destructive px-4 py-6 text-sm">
          Could not load your list. Reload the page.
        </p>
      ) : open.length === 0 && done.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          Nothing on your list for this meeting.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {open.map((item) => (
            <Row
              key={item.id}
              item={item}
              now={now}
              onToggle={() => void toggle(item)}
              onDelete={() => void remove(item)}
            />
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <div className="border-border border-t">
          <button
            type="button"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
            className="focus-visible:ring-ring text-muted-foreground w-full px-4 py-2.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
          >
            {done.length} done
          </button>
          {showDone && (
            <ul className="divide-border divide-y">
              {done.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  now={now}
                  onToggle={() => void toggle(item)}
                  onDelete={() => void remove(item)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="text-destructive border-border border-t px-4 py-3 text-sm"
        >
          {ERROR_COPY[error] ?? 'Could not save that. Try again.'}
        </p>
      )}
    </div>
  );
}

function Row({
  item,
  now,
  onToggle,
  onDelete,
}: {
  item: ActionItem;
  now: number;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const isDone = item.status === 'done';
  const late = !isDone && item.due_at !== null && isOverdue(item.due_at, now);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <button
        type="button"
        aria-pressed={isDone}
        aria-label={isDone ? `${item.text}: done` : `${item.text}: mark done`}
        onClick={onToggle}
        className={cn(
          'focus-visible:ring-ring border-border flex size-11 shrink-0 items-center justify-center rounded-md border focus-visible:ring-2 focus-visible:outline-none md:size-7',
          isDone && 'border-primary bg-primary/10 text-primary-ink',
        )}
      >
        {isDone && <Check className="size-4" aria-hidden />}
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 text-sm',
          isDone && 'text-muted-foreground line-through',
        )}
      >
        {item.text}
      </span>
      {item.due_at !== null && (
        <span
          className={cn(
            'tabular shrink-0 font-mono text-xs',
            late ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {relativeDays(item.due_at, now)}
        </span>
      )}
      <button
        type="button"
        aria-label={`Delete: ${item.text}`}
        onClick={onDelete}
        className="focus-visible:ring-ring text-muted-foreground hover:text-destructive flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none md:size-7"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </li>
  );
}
