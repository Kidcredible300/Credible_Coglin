import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Menu } from 'lucide-react';
import { NAV } from '@/lib/nav';
import { team } from '@/lib/mock/fixtures';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const PRIMARY = NAV.filter((n) => n.primary);

/**
 * Sidebar at ≥768px, bottom tab bar below.
 *
 * Mobile is built here from the start rather than retrofitted: COG-022 requires
 * this to work on a phone in a competition pit, and a desktop-first shell would
 * have to be torn apart to get there.
 */
export function AppShell() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const location = useLocation();
  const current = NAV.find((n) => n.to === location.pathname);

  return (
    <div className="bg-background min-h-dvh md:flex">
      {/* Skip link — the board has a lot of tab stops to wade through. */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground focus:ring-ring sr-only rounded-md px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2"
      >
        Skip to content
      </a>

      {/* ---------- Desktop sidebar ---------- */}
      <aside className="bg-sidebar border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:sticky md:top-0 md:flex md:h-dvh">
        <TeamMark />
        <nav className="flex-1 overflow-y-auto px-2 py-1" aria-label="Main">
          <ul className="space-y-0.5">
            {NAV.map((item) => (
              <li key={item.to}>
                <SideLink item={item} />
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-sidebar-border flex items-center justify-between border-t px-3 py-3">
          <span className="u-eyebrow">Theme</span>
          <ThemeToggle />
        </div>
      </aside>

      {/* ---------- Mobile top bar ---------- */}
      <div className="bg-background/95 border-border sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-3 backdrop-blur md:hidden">
        <span className="u-tape h-5 w-1.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="u-display truncate text-base leading-none">
            {current?.label ?? 'Coglin'}
          </div>
          <div className="text-muted-foreground mt-1 truncate text-xs">
            <span className="tabular font-mono">{team.team_number}</span>{' '}
            {team.name}
          </div>
        </div>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            className="hover:bg-accent focus-visible:ring-ring inline-flex size-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
            aria-label="More"
          >
            <Menu className="size-5" aria-hidden />
          </SheetTrigger>
          <SheetContent side="right" className="w-72 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <TeamMark />
            <nav className="px-2 py-1" aria-label="All sections">
              <ul className="space-y-0.5">
                {NAV.map((item) => (
                  <li key={item.to}>
                    <SideLink item={item} onNavigate={() => setSheetOpen(false)} />
                  </li>
                ))}
              </ul>
            </nav>
            <div className="border-border mt-2 flex items-center justify-between border-t px-3 py-3">
              <span className="u-eyebrow">Theme</span>
              <ThemeToggle />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* ---------- Content ---------- */}
      <main id="main" className="min-w-0 flex-1 pb-20 md:pb-0">
        <Outlet />
      </main>

      {/* ---------- Mobile tab bar ---------- */}
      <nav
        className="bg-background/95 border-border fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t backdrop-blur md:hidden"
        aria-label="Primary"
      >
        {PRIMARY.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                // 44px minimum touch target — pit day, cold hands, gloves.
                'focus-visible:ring-ring relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] focus-visible:ring-2 focus-visible:outline-none',
                isActive ? 'text-foreground' : 'text-muted-foreground',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    className="u-tape absolute inset-x-3 top-0 h-[3px]"
                    aria-hidden
                  />
                )}
                <Icon className="size-5" aria-hidden />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/**
 * Team identity. The number is set in mono and given more weight than the
 * name on purpose — in FTC the number IS the identity. Teams are announced,
 * queued, and scouted by number; the name is the nickname.
 */
function TeamMark() {
  return (
    <div className="border-sidebar-border flex items-center gap-3 border-b px-4 py-4">
      <span className="u-tape h-9 w-1.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <div className="tabular font-mono text-lg leading-none font-bold">
          {team.team_number}
        </div>
        <div className="text-muted-foreground mt-1 truncate text-xs">
          {team.name}
        </div>
      </div>
    </div>
  );
}

function SideLink({
  item,
  onNavigate,
}: {
  item: (typeof NAV)[number];
  onNavigate?: () => void;
}) {
  const { to, label, icon: Icon, stub } = item;
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'focus-visible:ring-ring relative flex min-h-11 items-center gap-3 rounded-md pr-3 pl-4 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Field tape marks the active row — a solid bar, not a hairline. */}
          {isActive && (
            <span
              className="u-tape absolute top-1.5 bottom-1.5 left-0 w-1"
              aria-hidden
            />
          )}
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          {stub && (
            <span className="u-eyebrow ml-auto text-[10px] normal-case">
              soon
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
