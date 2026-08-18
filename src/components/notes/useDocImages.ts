import { useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { UnsupportedImage, measure, prepareAndUpload } from '@/lib/upload';

/**
 * Getting a photo from a phone into a document.
 *
 * Salvaged from the block editor's upload flow, which was the most-tested part of
 * it. lib/upload.ts is unchanged and does the real work — canvas downscale then
 * EXIF strip, before any bytes leave the device.
 *
 * The one thing that had to be re-solved for ProseMirror: an in-flight upload
 * cannot remember its node's POSITION, because the student keeps typing and
 * positions move. It finds itself again by scanning for its own `uploadId`
 * attribute, which is the same hazard the old editor solved with a blocks ref.
 */

interface UploadState {
  status: 'uploading' | 'failed';
  progress: number;
  previewUrl: string;
  error?: string;
  retry: () => void;
}

/**
 * Module-level rather than React state, because the node view is rendered by
 * ProseMirror and cannot read a hook in this file. Keyed by uploadId, and the
 * blob URL is revoked as soon as the media id lands so a long meeting does not
 * leak one object URL per photo.
 */
const uploads = new Map<string, UploadState>();
const listeners = new Set<() => void>();

export function uploadState(uploadId: string): UploadState | null {
  return uploads.get(uploadId) ?? null;
}

/**
 * Subscribe a node view to upload progress.
 *
 * The node view is rendered by ProseMirror rather than by this module's tree, so
 * it cannot share React state with the hook below — it reads the map instead, and
 * without this it would never re-render, leaving every progress bar at zero and
 * every Retry button invisible.
 */
export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

function setUpload(uploadId: string, next: UploadState | null) {
  if (next === null) uploads.delete(uploadId);
  else uploads.set(uploadId, next);
  notify();
}

export function useDocImages(editor: Editor | null) {
  /**
   * Locate a node by its uploadId and rewrite its attributes.
   *
   * By attribute, never by a remembered position: between picking the file and
   * the upload landing, the student has typed three more paragraphs and every
   * position above the image has shifted.
   */
  const patchNode = useCallback(
    (uploadId: string, attrs: Record<string, unknown>) => {
      if (!editor) return;
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'mediaImage' && node.attrs.uploadId === uploadId) {
          found = pos;
          return false;
        }
        return true;
      });
      if (found === null) return;
      editor.view.dispatch(
        editor.view.state.tr.setNodeMarkup(found, undefined, {
          ...editor.view.state.doc.nodeAt(found)?.attrs,
          ...attrs,
        }),
      );
    },
    [editor],
  );

  const start = useCallback(
    async (file: File, uploadId: string, previewUrl: string) => {
      const run = async () => {
        setUpload(uploadId, {
          status: 'uploading',
          progress: 0,
          previewUrl,
          retry: () => void run(),
        });
        try {
          const media = await prepareAndUpload(file, (fraction) => {
            const current = uploads.get(uploadId);
            if (current) setUpload(uploadId, { ...current, progress: fraction });
          });
          patchNode(uploadId, { mediaId: media.id, uploadId: null });
          URL.revokeObjectURL(previewUrl);
          setUpload(uploadId, null);
        } catch (error) {
          setUpload(uploadId, {
            status: 'failed',
            progress: 0,
            previewUrl,
            error:
              error instanceof UnsupportedImage
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'That photo could not be uploaded.',
            retry: () => void run(),
          });
        }
      };
      await run();
    },
    [patchNode],
  );

  const insert = useCallback(
    async (files: File[]) => {
      if (!editor) return;
      for (const file of files) {
        const uploadId = crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        // Measured and inserted FIRST, so the box is reserved at the right shape
        // and the paragraphs below do not jump when the upload lands.
        const size = await measure(file);
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'mediaImage',
            attrs: {
              uploadId,
              width: size?.width ?? null,
              height: size?.height ?? null,
              alt: '',
            },
          })
          .run();
        void start(file, uploadId, previewUrl);
      }
    },
    [editor, start],
  );

  return { insert };
}
