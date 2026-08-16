import { Link } from 'react-router';
import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import {
  daysBetween,
  formatCount,
  formatHours,
  formatLongDate,
  formatTime,
  relativeDays,
} from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SeasonSpine } from '@/components/SeasonSpine';
import { StatTile } from '@/components/StatTile';
import { EvidenceMeter } from '@/components/EvidenceMeter';
import { Skeleton } from '@/components/Skeleton';
import { useSession } from '@/lib/session';
import type { AwardKey } from '@/types';

const AWARD_LABELS: Record<AwardKey, string> = {
  inspire: 'Inspire',
  think: 'Think',
  connect: 'Connect',
  reach: 'Reach',
  sustain: 'Sustain',
  innovate: 'Innovate',
  control: 'Control',
  design: 'Design',
};

export default function Dashboard() {
  const { team } = useSession();
  const now = api.now();
  const season = useAsync(api.getCurrentSeason);
  const calendar = useAsync(api.listCalendar);
  const tasks = useAsync(() => api.listTasks());
  const outreach = useAsync(api.listOutreach);
  const criteria = useAsync(api.listAwardCriteria);
  const meetings = useAsync(() => api.listMeetings());

  /**
   * The next one, not the first one.
   *
   * The list arrives ordered by start time across the whole season, so once a
   * team actually has a schedule, `meetings[0]` is a night in September and
   * this card would confidently show it until May. Cancelled occurrences are
   * skipped for the same reason: "next meeting" has to mean a meeting that is
   * going to happen.
   */
  const nextMeeting = meetings.data?.find(
    (m) => m.starts_at >= now && m.status !== 'cancelled',
  );

  const nextDeadline = calendar.data
    ?.filter((e) => e.starts_at >= now)
    .find((e) => e.kind === 'deadline' || e.kind === 'qualifier');

  const open = tasks.data?.filter((t) => t.status !== 'done') ?? [];
  const overdue = open.filter((t) => t.due_at !== null && t.due_at < now);
  const dueThisWeek = open.filter(
    (t) => t.due_at !== null && t.due_at >= now && daysBetween(now, t.due_at) <= 7,
  );

  const hours = outreach.data?.reduce((s, o) => s + o.hours, 0) ?? 0;
  const people = outreach.data?.reduce((s, o) => s + o.people_reached, 0) ?? 0;

  /**
   * What the hero says when there is no dated deadline to count down to. The
   * three cases are genuinely different, and only the last one is off-season.
   */
  const heroFallback = !season.data
    ? ' ' // still loading; the spine below already shows a skeleton
    : now < season.data.starts_at
      ? `Season ${season.data.label} starts soon`
      : now <= season.data.ends_at
        ? 'No dates on the calendar yet'
        : 'Off-season';

  const byAward = new Map<AwardKey, ReturnType<typeof Array.prototype.slice>>();
  for (const c of criteria.data ?? []) {
    if (!byAward.has(c.award)) byAward.set(c.award, []);
    byAward.get(c.award)!.push(c);
  }

  return (
    <>
      <PageHeader eyebrow={team.name} title="Dashboard" />

      <div className="space-y-8 px-4 py-6 md:px-8">

        {/* Hero: how much season is left, and what it is pointed at.
            On the ink slab rather than a card — this is the one fact the page
            owes the team, and a white card among white cards makes it just the
            first row of a list. */}
        <section className="bg-ink text-ink-foreground rounded-lg p-5 md:p-7">
          {nextDeadline ? (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className="u-display tabular font-mono text-5xl leading-none md:text-6xl">
                {daysBetween(now, nextDeadline.starts_at)}
              </span>
              <span className="u-display pb-1 text-lg md:text-xl">
                days to {nextDeadline.title.toLowerCase()}
              </span>
            </div>
          ) : (
            /* No countdown is not the same as no season. This used to say
               "Off-season" whenever the calendar was empty, which told a team
               three weeks out from kickoff that their season was over. Say what
               is actually known instead. */
            <div className="u-display text-2xl">{heroFallback}</div>
          )}

          <div className="mt-6">
            {season.data && calendar.data ? (
              <SeasonSpine
                season={season.data}
                events={calendar.data}
                now={now}
                onInk
              />
            ) : (
              <Skeleton className="bg-ink-foreground/10 h-16" />
            )}
          </div>
        </section>

        {/* Numbers a portfolio and a Reach interview actually ask for. */}
        <section>
          <h2 className="u-eyebrow mb-3">This season</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              value={formatHours(hours)}
              label="Outreach hours"
              hint={`${outreach.data?.length ?? 0} events logged`}
            />
            <StatTile value={formatCount(people)} label="People reached" />
            <StatTile
              value={dueThisWeek.length}
              label="Due this week"
              hint={`${open.length} open tasks`}
            />
            <StatTile
              value={overdue.length}
              label="Overdue"
              tone={overdue.length > 0 ? 'alert' : 'default'}
              hint={overdue.length === 0 ? 'nothing slipping' : undefined}
            />
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
          {/* Award readiness — the product's whole argument, on the front page. */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="u-eyebrow">Award readiness</h2>
              <Link
                to="/awards"
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              >
                Open tracker
              </Link>
            </div>
            <div className="bg-card border-border divide-border divide-y rounded-lg border">
              {criteria.status === 'loading' && (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                  <Skeleton className="h-4" />
                </div>
              )}
              {criteria.status === 'ready' && byAward.size === 0 && (
                <p className="text-muted-foreground px-4 py-6 text-center text-sm">
                  Award tracking opens once the 2026-27 criteria are in.
                </p>
              )}
              {[...byAward.entries()].map(([award, list]) => (
                <div
                  key={award}
                  className="grid grid-cols-[7rem_1fr] items-center gap-3 px-4 py-3"
                >
                  <span className="text-sm font-medium">
                    {AWARD_LABELS[award]}
                  </span>
                  <EvidenceMeter
                    label={AWARD_LABELS[award]}
                    states={list.map((c) => c.state)}
                  />
                </div>
              ))}
            </div>
            <p className="text-muted-foreground mt-2 text-xs">
              Criteria from the Competition Manual §6. Re-verify against the
              2026-27 manual at the season reveal.
            </p>
          </section>

          <div className="space-y-8">
            {/* Next meeting */}
            <section>
              <h2 className="u-eyebrow mb-3">Next meeting</h2>
              <div className="bg-card border-border rounded-lg border p-4">
                {meetings.status === 'loading' && <Skeleton className="h-16" />}
                {nextMeeting && (
                  <Link
                    to={`/meetings/${nextMeeting.id}`}
                    className="focus-visible:ring-ring block rounded focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <div className="u-display text-heading text-base">
                      {formatLongDate(nextMeeting.starts_at)}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-sm">
                      {formatTime(nextMeeting.starts_at)} ·{' '}
                      {relativeDays(nextMeeting.starts_at, now)}
                    </div>
                    <p className="mt-3 text-sm">{nextMeeting.title}</p>
                    {nextMeeting.location && (
                      <p className="text-muted-foreground mt-0.5 text-sm">
                        {nextMeeting.location}
                      </p>
                    )}
                  </Link>
                )}
                {/* No meeting is a real answer, not a slow one. The old code
                    fell back to a skeleton, so an empty team saw a loading bar
                    that never resolved. */}
                {meetings.status === 'ready' && !nextMeeting && (
                  <p className="text-muted-foreground text-sm">
                    Nothing scheduled yet.
                  </p>
                )}
              </div>
            </section>

            {/* Needs attention */}
            <section>
              <h2 className="u-eyebrow mb-3">Needs attention</h2>
              <ul className="bg-card border-border divide-border divide-y rounded-lg border">
                {[...overdue, ...dueThisWeek].slice(0, 5).map((t) => (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                    <span
                      className={
                        t.due_at !== null && t.due_at < now
                          ? 'bg-destructive mt-1.5 size-1.5 shrink-0 rounded-[1px]'
                          : 'bg-primary mt-1.5 size-1.5 shrink-0 rounded-[1px]'
                      }
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 text-sm">{t.title}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t.due_at !== null ? relativeDays(t.due_at, now) : ''}
                    </span>
                  </li>
                ))}
                {tasks.status === 'ready' &&
                  overdue.length === 0 &&
                  dueThisWeek.length === 0 && (
                    <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                      Nothing due this week. Coglin approves.
                    </li>
                  )}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
