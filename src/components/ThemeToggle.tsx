import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { applyTheme, storedTheme, watchSystemTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * A three-state segmented control rather than a two-state switch: "system" is a
 * real preference, and a toggle that silently overrides the OS is the reason
 * apps end up light at 2am.
 *
 * Styled for the ink slab, which is the only place it lives (sidebar foot, and
 * the same foot inside the mobile sheet). Selection is a lift in the surface
 * rather than a fill — a coloured chip here would compete with the bar marker
 * two inches above it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    setTheme(storedTheme());
    return watchSystemTheme(() => applyTheme('system'));
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="bg-ink-foreground/8 inline-flex gap-0.5 rounded-md p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={cn(
              'focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
              active
                ? 'bg-ink-foreground/16 text-ink-foreground'
                : 'text-ink-muted hover:text-ink-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
