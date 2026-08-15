import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-border flex flex-wrap items-end justify-between gap-4 border-b px-4 py-5 md:px-8 md:py-7">
      <div>
        {eyebrow && <div className="u-eyebrow mb-2">{eyebrow}</div>}
        <h1 className="u-display text-heading text-2xl md:text-3xl">{title}</h1>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}
