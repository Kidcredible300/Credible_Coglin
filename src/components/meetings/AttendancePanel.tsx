import { useCallback, useMemo, useState } from 'react';
import { Clock, LogOut } from 'lucide-react';
import * as api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AttendanceRecord, AttendanceState, Member } from '@/types';

/**
 * Taking the roll, shaped like the spreadsheet it replaces.
 *
 * The disposition is one of three, and "arrived late" / "left early" are
 * independent marks on top of it — because a student can do both on the same
 * evening, and an enum would force a coach to decide which half of that was the
 * real story.
 *
 * "All present" then deselect is the interaction, not fifteen individual taps:
 * everybody turning up is the common case, and the exceptions are what a coach
 * actually wants to spend attention on.
 */

const STATES: { id: AttendanceState; label: string; short: string }[] = [
  { id: 'present', label: 'Present', short: 'P' },
  { id: 'excused', label: 'Excused', short: 'E' },
  { id: 'absent', label: 'Absent', short: 'A' },
];

interface Draft {
  state: AttendanceState | null;
  arrived_late: boolean;
  left_early: boolean;
}

function toDraft(record: AttendanceRecord | undefined): Draft {
  return {
    state: record?.state ?? null,
    arrived_late: record?.arrived_late === 1,
    left_early: record?.left_early === 1,
  };
}

export function AttendancePanel({
  meetingId,
  members,
  attendance,
  canRecord,
  selfMemberId,
  onSaved,
}: {
  meetingId: string;
  members: Member[];
  attendance: AttendanceRecord[];
  /** Coaches and mentors take the roll; everyone else checks themselves in. */
  canRecord: boolean;
  selfMemberId: string;
  onSaved: () => void;
}) {
  const byMember = useMemo(
    () => new Map(attendance.map((a) => [a.member_id, a])),
    [attendance],
  );

  const [draft, setDraft] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(members.map((m) => [m.id, toDraft(byMember.get(m.id))])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const marked = members.filter((m) => draft[m.id]?.state !== null).length;

  const update = useCallback((memberId: string, patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, [memberId]: { ...prev[memberId], ...patch } }));
  }, []);

  async function save() {
    setPending(true);
    setError(null);
    try {
      await api.putAttendance(
        meetingId,
        members.map((m) => ({
          member_id: m.id,
          state: draft[m.id]?.state ?? null,
          arrived_late: draft[m.id]?.arrived_late ?? false,
          left_early: draft[m.id]?.left_early ?? false,
        })),
      );
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'forbidden'
          ? 'Only coaches and mentors can take the roll.'
          : 'Could not save attendance. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  async function checkInSelf(arrivedLate: boolean) {
    setPending(true);
    setError(null);
    try {
      await api.checkInSelf(meetingId, arrivedLate);
      onSaved();
    } catch {
      setError('Could not check you in. Try again.');
    } finally {
      setPending(false);
    }
  }

  if (!canRecord) {
    const mine = byMember.get(selfMemberId);
    return (
      <div className="bg-card border-border rounded-lg border p-4">
        {mine ? (
          <p className="text-sm">
            You are marked <span className="font-medium">{mine.state}</span>
            {mine.arrived_late === 1 && ' (arrived late)'}
            {mine.left_early === 1 && ' (left early)'}.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm">You are not on the roll yet.</p>
            <Button size="sm" disabled={pending} onClick={() => void checkInSelf(false)}>
              I&rsquo;m here
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void checkInSelf(true)}
            >
              Here, arrived late
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive mt-2 text-sm">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-card border-border rounded-lg border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground text-xs">
          <span className="tabular font-mono">{marked}</span> of{' '}
          <span className="tabular font-mono">{members.length}</span> marked
        </span>
        <div className="flex gap-2">
          {/* Everybody turning up is the normal case. Deselecting two people
              beats tapping fifteen. */}
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setDraft((prev) =>
                Object.fromEntries(
                  members.map((m) => [
                    m.id,
                    { ...prev[m.id], state: 'present' as AttendanceState },
                  ]),
                ),
              )
            }
          >
            All present
          </Button>
          <Button size="xs" disabled={pending} onClick={() => void save()}>
            {pending ? 'Saving…' : 'Save roll'}
          </Button>
        </div>
      </div>

      <ul className="divide-border divide-y">
        {members.map((member) => {
          const row = draft[member.id] ?? {
            state: null,
            arrived_late: false,
            left_early: false,
          };
          const present = row.state === 'present';

          return (
            <li
              key={member.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
            >
              <Avatar className="size-8 shrink-0">
                {member.photo_media_id && (
                  <AvatarImage
                    src={`/media/${member.photo_media_id}`}
                    alt=""
                  />
                )}
                <AvatarFallback className="text-xs">
                  {initials(member.display_name)}
                </AvatarFallback>
              </Avatar>

              <span className="min-w-32 flex-1 text-sm">{member.display_name}</span>

              <div className="border-border inline-flex rounded-md border p-0.5">
                {STATES.map((state) => (
                  <button
                    key={state.id}
                    type="button"
                    aria-pressed={row.state === state.id}
                    aria-label={`${member.display_name}: ${state.label}`}
                    onClick={() =>
                      update(member.id, {
                        // Tapping the current state clears it, which is how a
                        // coach un-marks somebody they hit by accident.
                        state: row.state === state.id ? null : state.id,
                      })
                    }
                    className={cn(
                      'focus-visible:ring-ring min-h-11 w-11 rounded text-sm font-medium focus-visible:ring-2 focus-visible:outline-none md:min-h-8 md:w-8',
                      row.state === state.id
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {state.short}
                  </button>
                ))}
              </div>

              {/* Only meaningful for somebody who was actually there. */}
              <div
                className={cn(
                  'flex gap-1 transition-opacity',
                  !present && 'pointer-events-none opacity-30',
                )}
              >
                <button
                  type="button"
                  aria-pressed={row.arrived_late}
                  aria-label={`${member.display_name}: arrived late`}
                  title="Arrived late"
                  disabled={!present}
                  onClick={() => update(member.id, { arrived_late: !row.arrived_late })}
                  className={cn(
                    'focus-visible:ring-ring inline-flex size-11 items-center justify-center rounded-md border focus-visible:ring-2 focus-visible:outline-none md:size-8',
                    row.arrived_late
                      ? 'border-primary bg-primary/10 text-primary-ink'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  <Clock className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-pressed={row.left_early}
                  aria-label={`${member.display_name}: left early`}
                  title="Left early"
                  disabled={!present}
                  onClick={() => update(member.id, { left_early: !row.left_early })}
                  className={cn(
                    'focus-visible:ring-ring inline-flex size-11 items-center justify-center rounded-md border focus-visible:ring-2 focus-visible:outline-none md:size-8',
                    row.left_early
                      ? 'border-primary bg-primary/10 text-primary-ink'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-destructive px-4 py-2 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
