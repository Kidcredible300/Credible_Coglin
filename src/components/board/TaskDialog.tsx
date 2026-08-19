import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatDate, relativeDays } from '@/lib/format';
import { TASK_COLUMNS, type Member, type Task, type TaskStatus } from '@/types';

/** epoch seconds -> the yyyy-mm-dd a date input wants, in the browser's zone. */
function toDateInput(due: number | null): string {
  if (due === null) return '';
  const d = new Date(due * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A bare date means midnight local, which is what somebody means by "due
 * Friday" — the browser's zone is the one they picked it in. Same conversion as
 * CoachActionItems.
 */
function fromDateInput(value: string): number | null {
  if (!value) return null;
  return Math.floor(new Date(`${value}T00:00`).getTime() / 1000);
}

/** The unassigned option needs a non-empty value; Select reserves ''. */
const UNASSIGNED = '__none__';

export function TaskDialog({
  task,
  assignee,
  members,
  now,
  canEdit,
  onOpenChange,
  onPatch,
  onDelete,
}: {
  task: Task | null;
  assignee?: Member;
  members: Member[];
  now: number;
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  /** One patch is one update_task op. Null clears a field. */
  onPatch: (task: Task, patch: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}) {
  // Local drafts for the free-text fields so typing does not fire a write per
  // keystroke. Committed on blur and on Cmd/Ctrl+Enter; selects and the date
  // commit immediately, because a dropdown has no natural "done" moment.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [log, setLog] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setBody(task.body ?? '');
    setLog(task.decision_log ?? '');
    setConfirmingDelete(false);
    // Keyed on the id, not the whole task: re-syncing on every field change
    // would fight the poll and stamp on half-typed text.
  }, [task?.id]);

  function commit(field: 'title' | 'body' | 'decision_log', draft: string): void {
    if (!task) return;
    const trimmed = draft.trim();
    if (field === 'title') {
      // No null form — the server refuses a blank title, and a card with no
      // label is unreachable. Snap back rather than showing an error for
      // something the user can see is empty.
      if (!trimmed) {
        setTitle(task.title);
        return;
      }
      if (trimmed !== task.title) onPatch(task, { title: trimmed });
      return;
    }
    const current = field === 'body' ? task.body : task.decision_log;
    const next = trimmed === '' ? null : trimmed;
    if (next !== current) onPatch(task, { [field]: next } as Partial<Task>);
  }

  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">{task.title}</DialogTitle>
              <DialogDescription className="sr-only">
                Edit this task, including its decision log.
              </DialogDescription>
              {canEdit ? (
                <Input
                  value={title}
                  maxLength={200}
                  aria-label="Task title"
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => commit('title', title)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commit('title', title);
                    }
                  }}
                  className="u-display min-h-11 border-transparent bg-transparent px-0 text-xl shadow-none md:min-h-9 md:text-xl"
                />
              ) : (
                <p className="u-display text-xl">{task.title}</p>
              )}
              <p className="text-muted-foreground text-sm">
                {assignee ? assignee.display_name : 'Unassigned'}
                {task.due_at !== null &&
                  ` · due ${formatDate(task.due_at)} (${relativeDays(task.due_at, now)})`}
              </p>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                {/* Dragging is the mouse affordance; this is the one that works
                    for everyone else — keyboard, screen reader, and a thumb in
                    a pit. */}
                <Label htmlFor="task-status" className="u-eyebrow">
                  Status
                </Label>
                <Select
                  value={task.status}
                  disabled={!canEdit}
                  onValueChange={(v) => onPatch(task, { status: v as TaskStatus })}
                >
                  <SelectTrigger id="task-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_COLUMNS.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-due" className="u-eyebrow">
                  Due
                </Label>
                <Input
                  id="task-due"
                  type="date"
                  disabled={!canEdit}
                  value={toDateInput(task.due_at)}
                  // Clearing the field sends an explicit null, which the server
                  // now honours — the old COALESCE patch could set a due date
                  // but never remove one.
                  onChange={(e) => onPatch(task, { due_at: fromDateInput(e.target.value) })}
                  className="min-h-11 w-full md:min-h-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-assignee" className="u-eyebrow">
                Assignee
              </Label>
              <Select
                value={task.assignee_member_id ?? UNASSIGNED}
                disabled={!canEdit}
                onValueChange={(v) =>
                  onPatch(task, { assignee_member_id: v === UNASSIGNED ? null : v })
                }
              >
                <SelectTrigger id="task-assignee" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-body" className="u-eyebrow">
                Notes
              </Label>
              <Textarea
                id="task-body"
                value={body}
                maxLength={5000}
                disabled={!canEdit}
                placeholder="What needs doing?"
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => commit('body', body)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit('body', body);
                }}
              />
            </div>

            {/* The decision log is the reason this dialog exists. It gets its
                own framed block rather than a second notes field, because come
                March this is what the portfolio's engineering-process pages get
                written from — and it was read-only until now, which made the
                framing a promise the UI did not keep. */}
            <div className="space-y-1.5">
              <Label htmlFor="task-log" className="u-eyebrow">
                Decision log
              </Label>
              <Textarea
                id="task-log"
                value={log}
                maxLength={5000}
                disabled={!canEdit}
                placeholder="What did you try, and why did you change it?"
                onChange={(e) => setLog(e.target.value)}
                onBlur={() => commit('decision_log', log)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    commit('decision_log', log);
                  }
                }}
                className="border-primary-ink bg-muted/50 border-l-2"
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                Written now, not reconstructed in March. This is what the Think
                award asks for.
              </p>
            </div>

            {canEdit && (
              <DialogFooter className="sm:justify-start">
                {confirmingDelete ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">Delete this task?</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        onDelete(task);
                        onOpenChange(false);
                      }}
                    >
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Delete task
                  </Button>
                )}
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
