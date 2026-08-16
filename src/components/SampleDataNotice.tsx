/**
 * Marks a screen that is still reading fixtures.
 *
 * The alpha team is a real FIRST team whose season data has to be trustworthy
 * from day one. A board full of convincing invented tasks, unlabelled, is worse
 * than an empty one — a coach could plan around it. This notice is the contract
 * that the roster is theirs and this screen is not, and it comes out screen by
 * screen as each feature lands on real data.
 */
export function SampleDataNotice({ feature }: { feature: string }) {
  return (
    <div
      role="note"
      className="border-border bg-muted/60 text-muted-foreground flex items-start gap-3 rounded-md border border-dashed px-4 py-3 text-sm"
    >
      <span className="u-tape mt-0.5 h-4 w-1.5 shrink-0" aria-hidden />
      <p className="leading-relaxed">
        <strong className="text-foreground font-medium">Sample data.</strong>{' '}
        {feature} isn't connected to your team yet — nothing here is saved.
        Your roster is real.
      </p>
    </div>
  );
}
