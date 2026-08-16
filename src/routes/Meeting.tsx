import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, MapPin } from 'lucide-react';
import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useSession } from '@/lib/session';
import { formatLongDate, formatTime, relativeDays } from '@/lib/format';
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
import { MEETING_KINDS } from '@/types';

const KIND_LABEL = new Map(MEETING_KINDS.map((k) => [k.id, k.label]));

/**
 * One meeting.
 *
 * Phase 1 is the frame: when, where, and the coach's controls. The agenda, the
 * block editor and attendance land here in phase 2 — the tabs are deliberately
 * not stubbed in yet, because a tab that opens onto nothing is worse than a
 * screen that has not grown it.
 */
export default function Meeting() {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const detail = useAsync(
    () => api.getMeeting(meetingId as string),
    [meetingId, reloadKey],
  );
  const { member } = useSession();
  const canEdit = member.role === 'coach' || member.role === 'mentor';
  const now = api.now();

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

  const { meeting } = detail.data;
  const cancelled = meeting.status === 'cancelled';

  async function onCancel() {
    await api.cancelMeeting(meeting.id);
    setReloadKey((k) => k + 1);
  }

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
            {cancelled && meeting.cancel_reason && (
              <p className="text-muted-foreground mt-2 text-sm italic">
                {meeting.cancel_reason}
              </p>
            )}
          </div>

          {canEdit && !cancelled && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Manage
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void onCancel()}>
                  Cancel meeting
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="px-4 py-6 md:px-8">
        <EmptyState
          title="Notes arrive with the next release."
          aside="Agendas, notes and attendance land here next — and every paragraph and photo will be one tap from your portfolio."
        />
      </div>
    </>
  );
}
