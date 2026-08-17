import { useRef, useState } from 'react';
import { Camera, ShieldCheck, Trash2 } from 'lucide-react';
import * as api from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { initials } from '@/lib/format';
import { prepareAndUpload, UnsupportedImage } from '@/lib/upload';
import { cn } from '@/lib/utils';
import type { Member } from '@/types';

/**
 * A student's photo on the roster, and the consent gate in front of it.
 *
 * The gate is the feature, not an obstacle to it. A photograph of a child is
 * personal information under COPPA, and Coglin cannot obtain verifiable parental
 * consent — no web form can. What it can do is refuse to hold the photo until a
 * named coach has confirmed the signed FIRST Consent and Release exists on
 * paper. So the affordance a coach meets first is "confirm the form is on file",
 * and the camera only appears afterwards.
 *
 * Uploading goes through the same pipeline as a meeting photo, which means it is
 * downscaled and EXIF-stripped before it leaves the device. See
 * migrations/0004_roster_photos.sql for the rest of the reasoning.
 */
export function RosterPhoto({
  member,
  canManage,
  onChanged,
}: {
  member: Member;
  canManage: boolean;
  onChanged: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    try {
      // Same preparation as a meeting photo — downscaled and EXIF-stripped
      // before it leaves the device — posted to the consent-gated route.
      await prepareAndUpload(file, undefined, `/api/members/${member.id}/photo`);
      onChanged();
    } catch (err) {
      // uploadImage already maps server codes to copy, including the consent
      // refusal, so its message is the one worth showing.
      setError(
        err instanceof UnsupportedImage || err instanceof Error
          ? err.message
          : 'That photo could not be uploaded.',
      );
    } finally {
      URL.revokeObjectURL(url);
      setPreview(null);
      setBusy(false);
    }
  }

  const src = preview ?? (member.photo_media_id ? `/media/${member.photo_media_id}` : null);

  return (
    <div className="flex items-center gap-2">
      <Avatar className={cn('size-10', busy && 'opacity-60')}>
        {src && <AvatarImage src={src} alt="" />}
        <AvatarFallback>{initials(member.display_name)}</AvatarFallback>
      </Avatar>

      {canManage && (
        <>
          {!member.photo_consent ? (
            // No camera until the form is on file. A disabled camera with a
            // tooltip would invite clicking past it; this makes the consent step
            // the only thing there is to do.
            //
            // Icon-only, because a labelled button squeezes the student's name
            // out of a roster card — and the name is the thing the row is for.
            // The explanatory line above the roster carries the wording.
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={`Record photo consent for ${member.display_name}`}
              title="Confirm the signed FIRST Consent and Release is on file for this student"
              onClick={async () => {
                setBusy(true);
                try {
                  await api.recordPhotoConsent(member.id);
                  onChanged();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Photo options for ${member.display_name}`}
                >
                  <Camera className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  {member.photo_media_id ? 'Replace photo' : 'Add photo'}
                </DropdownMenuItem>
                {member.photo_media_id && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      void api.deleteMemberPhoto(member.id).then(onChanged)
                    }
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    Remove photo
                  </DropdownMenuItem>
                )}
                {/* Withdrawing takes the photo down too — a parent asking for it
                    to come down and a record saying consent is on file cannot
                    both be true. */}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    void api.withdrawPhotoConsent(member.id).then(onChanged)
                  }
                >
                  Withdraw consent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
        </>
      )}

      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </div>
  );
}
