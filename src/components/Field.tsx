/**
 * Labelled form field for the unauthenticated screens (login, signup, invite).
 *
 * Shared rather than repeated because these three screens are the only place a
 * stranger ever judges whether Coglin is real software. Fields that drift apart
 * across them read as sloppy at exactly the wrong moment.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Field({
  name,
  label,
  hint,
  ...props
}: { name: string; label: string; hint?: ReactNode } & ComponentProps<typeof Input>) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} aria-describedby={hintId} {...props} />
      {hint && (
        <p id={hintId} className="text-muted-foreground text-xs leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}
