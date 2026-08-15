import * as api from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { formatCount, formatHours, formatLongDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatTile } from '@/components/StatTile';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';

export default function Outreach() {
  const outreach = useAsync(api.listOutreach);
  const list = outreach.data ?? [];

  const hours = list.reduce((s, o) => s + o.hours, 0);
  const people = list.reduce((s, o) => s + o.people_reached, 0);

  return (
    <>
      <PageHeader eyebrow="2026-27" title="Outreach log" />

      <div className="space-y-8 px-4 py-6 md:px-8">
        {/* The rollup is the header, not a footnote: these three figures are
            what a portfolio page and a Reach interview ask for, and teams
            currently reconstruct them from memory in March. */}
        <section>
          <div className="grid grid-cols-3 gap-3 lg:max-w-2xl">
            <StatTile value={formatHours(hours)} label="Hours" />
            <StatTile value={formatCount(people)} label="People reached" />
            <StatTile value={list.length} label="Events" />
          </div>
        </section>

        <section>
          <h2 className="u-eyebrow mb-3">Entries</h2>

          {outreach.status === 'loading' && <Skeleton className="h-64" />}

          {outreach.status === 'ready' && list.length === 0 && (
            <EmptyState
              title="No outreach logged yet."
              aside="Log an event right after it happens — the details you'll want in March are the ones you forget by Friday."
            />
          )}

          <ul className="bg-card border-border divide-border divide-y rounded-lg border">
            {list.map((o) => (
              <li key={o.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="flex-1 text-sm font-medium">{o.title}</span>
                  <span className="text-muted-foreground tabular font-mono text-xs">
                    {formatLongDate(o.occurred_at)}
                  </span>
                </div>

                <div className="text-muted-foreground mt-1.5 flex gap-4 text-xs">
                  <span className="tabular font-mono">
                    {formatHours(o.hours)} h
                  </span>
                  <span className="tabular font-mono">
                    {formatCount(o.people_reached)} reached
                  </span>
                </div>

                {o.what_we_learned && (
                  <p className="text-muted-foreground mt-2 text-sm italic">
                    {o.what_we_learned}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
