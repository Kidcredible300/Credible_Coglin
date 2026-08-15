import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { formatDate, relativeDays } from '@/lib/format';
import { TASK_COLUMNS, type Member, type Task, type TaskStatus } from '@/types';

export function TaskDialog({
  task,
  assignee,
  now,
  onOpenChange,
  onStatusChange,
}: {
  task: Task | null;
  assignee?: Member;
  now: number;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (task: Task, status: TaskStatus) => void;
}) {
  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="u-display text-xl">
                {task.title}
              </DialogTitle>
              <DialogDescription>
                {assignee ? assignee.display_name : 'Unassigned'}
                {task.due_at !== null &&
                  ` · due ${formatDate(task.due_at)} (${relativeDays(task.due_at, now)})`}
              </DialogDescription>
            </DialogHeader>

            {/* Dragging is the mouse affordance; this is the one that works for
                everyone else — keyboard, screen reader, and a thumb in a pit. */}
            <div className="flex items-center gap-3">
              <label htmlFor="task-status" className="u-eyebrow">
                Status
              </label>
              <Select
                value={task.status}
                onValueChange={(v) => onStatusChange(task, v as TaskStatus)}
              >
                <SelectTrigger id="task-status" className="w-44">
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

            {task.body && <p className="text-sm">{task.body}</p>}

            {/* The decision log is the reason this dialog exists. It gets its
                own framed block rather than a notes field, because come March
                this is what the portfolio's engineering-process pages get
                written from. */}
            <div>
              <h3 className="u-eyebrow mb-2">Decision log</h3>
              {task.decision_log ? (
                <blockquote className="border-primary-ink bg-muted/50 rounded-r-md border-l-2 py-2.5 pr-3 pl-3 text-sm">
                  {task.decision_log}
                </blockquote>
              ) : (
                <p className="text-muted-foreground border-border rounded-md border border-dashed px-3 py-4 text-sm">
                  Nothing recorded. What did you try, and why did you change it?
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
