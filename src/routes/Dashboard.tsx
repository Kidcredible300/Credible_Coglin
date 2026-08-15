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
  const now = api.now();
  const season = useAsync(api.getCurrentSeason);
  const calendar = useAsync(api.listCalendar);
  const tasks = useAsync(() => api.listTasks());
  const outreach = useAsync(api.listOutreach);
  const criteria = useAsync(api.listAwardCriteria);
  const meetings = useAsync(api.listMeetings);

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

  const byAward = new Map<AwardKey, ReturnType<typeof Array.prototype.slice>>();
  for (const c of criteria.data ?? []) {
    if (!byAward.has(c.award)) byAward.set(c.award, []);
    byAward.get(c.award)!.push(c);
  }

  return (
    <>
      <PageHeader eyebrow="Ferrous Wheels" title="Dashboard" />

      <div className="space-y-8 px-4 py-6 md:px-8">
        {/* Hero: how much season is left, and what it is pointed at. */}
        <section className="bg-card border-border rounded-lg border p-5 md:p-7">
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
            <div className="u-display text-2xl">Off-season</div>
          )}

          <div className="mt-6">
            {season.data && calendar.data ? (
              <SeasonSpine
                season={season.data}
                events={calendar.data}
                now={now}
              />
            ) : (
              <Skeleton className="h-16" />
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
                {meetings.data?.[0] ? (
                  <>
                    <div className="u-display text-base">
                      {formatLongDate(meetings.data[0].starts_at)}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-sm">
                      {formatTime(meetings.data[0].starts_at)} ·{' '}
                      {relativeDays(meetings.data[0].starts_at, now)}
                    </div>
                    {meetings.data[0].agenda && (
                      <p className="mt-3 text-sm">{meetings.data[0].agenda}</p>
                    )}
                  </>
                ) : (
                  <Skeleton className="h-16" />
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
