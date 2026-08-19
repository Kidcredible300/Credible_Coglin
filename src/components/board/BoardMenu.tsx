import { useEffect, useState } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { SUB_TEAMS, type Board, type SubTeam } from '@/types';

/** Select reserves the empty string, so "no sub-team" needs a real value. */
const NONE = '__none__';

/**
 * Rename, re-file or delete the board being viewed.
 *
 * Delete is coach-only and two-step by necessity: the server answers 409
 * `board_has_tasks` with a count, and forcing past it destroys a sub-team's
 * whole season. The count goes in the confirm so the blast radius is visible
 * before the second click, not after.
 */
export function BoardMenu({
  board,
  canManage,
  canDelete,
  onRename,
  onDelete,
}: {
  board: Board;
  canManage: boolean;
  canDelete: boolean;
  onRename: (patch: { name?: string; sub_team?: SubTeam | null }) => Promise<void>;
  /** Resolves to the task count when the server refused for want of `force`. */
  onDelete: (force: boolean) => Promise<{ blockedBy: number } | void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board.name);
  const [subTeam, setSubTeam] = useState<string>(board.sub_team ?? NONE);
  const [pending, setPending] = useState(false);
  const [blockedBy, setBlockedBy] = useState<number | null>(null);

  useEffect(() => {
    setName(board.name);
    setSubTeam(board.sub_team ?? NONE);
  }, [board.id, board.name, board.sub_team]);

  if (!canManage) return null;

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await onRename({
        name: trimmed,
        sub_team: subTeam === NONE ? null : (subTeam as SubTeam),
      });
      setEditing(false);
    } finally {
      setPending(false);
    }
  }

  async function remove(force: boolean): Promise<void> {
    setPending(true);
    try {
      const result = await onDelete(force);
      if (result && 'blockedBy' in result) {
        setBlockedBy(result.blockedBy);
        return;
      }
      setBlockedBy(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Manage ${board.name}`}
            className="size-11 md:size-7"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            Rename or re-file
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void remove(false)}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete board
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editing} onOpenChange={(open) => !open && setEditing(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="u-display text-xl">Board</DialogTitle>
            <DialogDescription>
              The sub-team is a label, not a permission — anyone on the team can
              still work this board.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="board-name">Name</Label>
            <Input
              id="board-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
              className="min-h-11 md:min-h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="board-subteam">Sub-team</Label>
            <Select value={subTeam} onValueChange={setSubTeam}>
              <SelectTrigger id="board-subteam" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {SUB_TEAMS.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    {st.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button disabled={pending || name.trim() === ''} onClick={() => void save()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={blockedBy !== null} onOpenChange={(open) => !open && setBlockedBy(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="u-display text-xl">
              Delete {board.name}?
            </DialogTitle>
            <DialogDescription>
              {blockedBy === 1
                ? 'One task is on this board and will be deleted with it.'
                : `${blockedBy} tasks are on this board and will be deleted with it.`}{' '}
              Decision logs go too, and those are award material.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBlockedBy(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void remove(true)}
            >
              Delete anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
