import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  GripVertical,
  ImagePlus,
} from 'lucide-react';
import { measure, prepareAndUpload } from '@/lib/upload';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  BLOCK_KIND_LABELS,
  CARET_END,
  mergeBackward,
  moveBlock,
  newBlock,
  PLACEHOLDER,
  splitAt,
  type DraftBlock,
} from '@/lib/notes';
import { cn } from '@/lib/utils';
import type { BlockKind } from '@/types';

/**
 * A block editor built from textareas rather than a rich-text engine.
 *
 * The reason is the product requirement, not minimalism: a student must be able
 * to flag one paragraph or one picture for the portfolio, which means each one
 * has to be an addressable server row with a stable id the inbox can link to.
 * ProseMirror and Lexical both want to own the document as a single node tree,
 * so every autosave becomes a tree-to-rows mapping and stable per-node ids need
 * a plugin — two representations of the same fact, and the tree is the one that
 * drifts out of step with the flags.
 *
 * What that costs, stated plainly rather than waved away: Cmd+Z will not
 * un-split a paragraph (browser undo works inside one textarea, so typing is
 * covered), and you cannot select across blocks to copy. The second is answered
 * by "Copy notes", which is what students want anyway because the destination
 * is Discord. Revisit if inline formatting or multi-cursor editing is ever
 * actually asked for.
 */

const KIND_CLASS: Record<BlockKind, string> = {
  heading: 'u-display text-heading text-lg',
  paragraph: 'text-sm leading-relaxed',
  bullet: 'text-sm leading-relaxed',
  decision: 'text-sm leading-relaxed',
  action: 'text-sm leading-relaxed',
  image: 'text-muted-foreground text-xs italic',
};

/** Local-only state for a photo that is still on its way to R2. */
export interface UploadState {
  previewUrl: string;
  progress: number;
  error?: string;
  width?: number;
  height?: number;
}

interface BlockRowProps {
  block: DraftBlock;
  index: number;
  total: number;
  flagged: boolean;
  readOnly: boolean;
  upload?: UploadState;
  onChange: (index: number, text: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => void;
  onToggleFlag: (block: DraftBlock) => void;
  onSetKind: (index: number, kind: BlockKind) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onDelete: (index: number) => void;
  onRetryUpload: (blockId: string) => void;
}

const BlockRow = memo(function BlockRow({
  block,
  index,
  total,
  flagged,
  readOnly,
  upload,
  onChange,
  onKeyDown,
  onToggleFlag,
  onSetKind,
  onMove,
  onDelete,
  onRetryUpload,
}: BlockRowProps) {
  const isImage = block.kind === 'image';
  const src = block.media_id ? `/media/${block.media_id}` : upload?.previewUrl;

  return (
    <div className="group/row relative flex items-start gap-1 pl-3">
      {/* The mark for a flagged block is the same field tape that marks the
          active nav row: it reads from across a shop and then gets out of the
          way while you are actually reading. A background tint would fight the
          text it is supposed to be highlighting. */}
      {flagged && (
        <span className="u-tape absolute top-1 bottom-1 left-0 w-[3px]" aria-hidden />
      )}

      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Block ${index + 1} options`}
              className="text-muted-foreground focus-visible:ring-ring mt-0.5 flex size-11 shrink-0 items-center justify-center rounded opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none md:size-7"
            >
              <GripVertical className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {BLOCK_KIND_LABELS.map((kind) => (
              <DropdownMenuItem
                key={kind.id}
                onSelect={() => onSetKind(index, kind.id)}
              >
                {kind.label}
                <span className="text-muted-foreground ml-2 text-xs">{kind.hint}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {/* Dragging is a mouse affordance. These are the ones that work for
                a keyboard, a screen reader, and a thumb in a pit — the same
                reason the board has a status Select next to its drag handles. */}
            <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index, -1)}>
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === total - 1}
              onSelect={() => onMove(index, 1)}
            >
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(index)}>
              Delete block
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {block.kind === 'bullet' && (
        <span className="text-muted-foreground mt-[7px] shrink-0 text-sm" aria-hidden>
          •
        </span>
      )}
      {block.kind === 'decision' && (
        <span className="bg-primary mt-[9px] h-3 w-[3px] shrink-0 rounded-sm" aria-hidden />
      )}
      {block.kind === 'action' && (
        <span
          className="border-muted-foreground mt-[7px] size-3.5 shrink-0 rounded-[3px] border"
          aria-hidden
        />
      )}

      {isImage ? (
        <figure className="flex-1 py-1">
          {src && (
            <img
              src={src}
              alt={block.text || 'Photo from this meeting'}
              // The box is reserved from the intrinsic size before the upload
              // finishes, so the notes below do not jump when it lands. Capped
              // because a portrait phone photo at full width owns the whole
              // screen and buries the next three paragraphs.
              style={
                upload?.width && upload?.height
                  ? { aspectRatio: `${upload.width} / ${upload.height}` }
                  : undefined
              }
              className={cn(
                'border-border max-h-[60vh] w-full rounded-md border object-contain',
                upload && !upload.error && 'opacity-60',
              )}
            />
          )}

          {upload && !upload.error && (
            <div
              className="bg-muted mt-1.5 h-1 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-label="Uploading photo"
              aria-valuenow={Math.round(upload.progress * 100)}
            >
              <div
                className="bg-primary h-full transition-[width]"
                style={{ width: `${Math.round(upload.progress * 100)}%` }}
              />
            </div>
          )}

          {upload?.error && (
            // The thumbnail stays. A student must be able to see their photo
            // did not vanish, or they will take it again and end up with two.
            <div
              role="alert"
              className="text-destructive mt-1.5 flex flex-wrap items-center gap-2 text-xs"
            >
              <span>{upload.error}</span>
              <button
                type="button"
                onClick={() => onRetryUpload(block.id)}
                className="focus-visible:ring-ring min-h-11 font-medium underline focus-visible:ring-2 focus-visible:outline-none"
              >
                Retry
              </button>
            </div>
          )}

          {/* The caption is load-bearing, not decoration: it is what makes a
              candidate card readable in March, and it doubles as alt text. */}
          <figcaption className="grid">
            <textarea
              id={`block-input-${block.id}`}
              value={block.text}
              readOnly={readOnly}
              rows={1}
              placeholder={PLACEHOLDER.image}
              aria-label="Photo caption"
              onChange={(e) => onChange(index, e.target.value)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'placeholder:text-muted-foreground/60 col-start-1 row-start-1 mt-1.5 resize-none overflow-hidden bg-transparent focus-visible:outline-none',
                KIND_CLASS.image,
              )}
            />
            <span
              aria-hidden
              className={cn(
                'col-start-1 row-start-1 mt-1.5 invisible break-words whitespace-pre-wrap',
                KIND_CLASS.image,
              )}
            >
              {block.text + '\n'}
            </span>
          </figcaption>
        </figure>
      ) : (
      /* Autogrow by grid overlay: a hidden replica sizes the row and the
         textarea fills the same cell. Writing scrollHeight to style on every
         keystroke forces a synchronous layout per block, which you can feel on
         a school Chromebook with sixty blocks on screen. */
      <div className="grid flex-1 py-1">
        <textarea
          id={`block-input-${block.id}`}
          value={block.text}
          readOnly={readOnly}
          rows={1}
          placeholder={PLACEHOLDER[block.kind]}
          aria-label={`${block.kind} block`}
          onChange={(e) => onChange(index, e.target.value)}
          onKeyDown={(e) => onKeyDown(e, index)}
          className={cn(
            'placeholder:text-muted-foreground/60 col-start-1 row-start-1 resize-none overflow-hidden bg-transparent focus-visible:outline-none',
            KIND_CLASS[block.kind],
          )}
        />
        <span
          aria-hidden
          className={cn(
            'col-start-1 row-start-1 invisible break-words whitespace-pre-wrap',
            KIND_CLASS[block.kind],
          )}
        >
          {block.text + '\n'}
        </span>
      </div>
      )}

      {/* One tap, no dialog, no required fields. Mid-meeting a modal is a stop
          sign, and "which award is this for?" is a March question — it gets
          asked in the inbox by somebody thinking about the portfolio, not by
          somebody trying to keep up with what the build lead just said. */}
      <button
        type="button"
        aria-pressed={flagged}
        aria-label={
          flagged
            ? 'Flagged for portfolio — tap to remove'
            : 'Flag this for the portfolio'
        }
        onClick={() => onToggleFlag(block)}
        className={cn(
          'focus-visible:ring-ring mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none md:size-8',
          flagged
            ? 'text-primary-ink'
            : 'text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 max-md:opacity-60',
        )}
      >
        {flagged ? (
          <BookmarkCheck className="size-4" aria-hidden />
        ) : (
          <Bookmark className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
});

export function NoteEditor({
  blocks,
  flaggedIds,
  readOnly = false,
  onChange,
  onToggleFlag,
}: {
  blocks: DraftBlock[];
  flaggedIds: Set<string>;
  readOnly?: boolean;
  /** `immediate` marks a structural edit, which should not sit in a debounce. */
  onChange: (blocks: DraftBlock[], immediate: boolean) => void;
  onToggleFlag: (block: DraftBlock) => void;
}) {
  /**
   * A key handler can only name WHICH block should take the caret and where.
   * The element does not exist until React has rendered the new list, so the
   * intent is parked here and consumed in a layout effect — which is what makes
   * a split or a merge feel like one keystroke instead of two frames.
   */
  const focusIntent = useRef<{ id: string; caret: number } | null>(null);

  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Async upload callbacks would otherwise close over a stale block list — the
   * student keeps typing while a photo is in flight, and writing the media_id
   * back into an old array would silently discard everything typed since.
   */
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  /** Held outside the block model so the draft in localStorage never sees a
   *  blob URL, and so they can be revoked rather than leaked. */
  const previewUrls = useRef(new Map<string, string>());
  const pendingFiles = useRef(new Map<string, File>());

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const runUpload = useCallback(
    async (blockId: string, file: File) => {
      setUploads((prev) => ({
        ...prev,
        [blockId]: { ...prev[blockId], progress: 0, error: undefined },
      }));
      try {
        const uploaded = await prepareAndUpload(file, (fraction) =>
          setUploads((prev) =>
            prev[blockId]
              ? { ...prev, [blockId]: { ...prev[blockId], progress: fraction } }
              : prev,
          ),
        );

        const next = blocksRef.current.map((b) =>
          b.id === blockId ? { ...b, media_id: uploaded.id } : b,
        );
        onChange(next, true);

        const url = previewUrls.current.get(blockId);
        if (url) {
          URL.revokeObjectURL(url);
          previewUrls.current.delete(blockId);
        }
        pendingFiles.current.delete(blockId);
        setUploads((prev) => {
          const rest = { ...prev };
          delete rest[blockId];
          return rest;
        });
      } catch (error) {
        setUploads((prev) => ({
          ...prev,
          [blockId]: {
            ...prev[blockId],
            progress: 0,
            error:
              error instanceof Error
                ? error.message
                : 'That photo could not be uploaded.',
          },
        }));
      }
    },
    [onChange],
  );

  const insertImages = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const size = await measure(file);
        const block = newBlock('image', '');
        const previewUrl = URL.createObjectURL(file);
        previewUrls.current.set(block.id, previewUrl);
        pendingFiles.current.set(block.id, file);

        setUploads((prev) => ({
          ...prev,
          [block.id]: {
            previewUrl,
            progress: 0,
            width: size?.width,
            height: size?.height,
          },
        }));

        onChange([...blocksRef.current, block], true);
        void runUpload(block.id, file);
      }
    },
    [onChange, runUpload],
  );

  const onRetryUpload = useCallback(
    (blockId: string) => {
      const file = pendingFiles.current.get(blockId);
      if (file) void runUpload(blockId, file);
    },
    [runUpload],
  );

  /** Paste is handled on the container: the target is wherever the caret is,
   *  and a listener per textarea would be sixty listeners doing one job. */
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (readOnly) return;
      const files = [...event.clipboardData.files].filter((f) =>
        f.type.startsWith('image/'),
      );
      if (files.length === 0) return; // plain text falls through to the textarea
      event.preventDefault();
      void insertImages(files);
    },
    [insertImages, readOnly],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      // Guarded on Files, so dragging a block does not read as a zero-file drop.
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files].filter((f) =>
        f.type.startsWith('image/'),
      );
      if (files.length > 0) void insertImages(files);
    },
    [insertImages, readOnly],
  );

  useLayoutEffect(() => {
    const intent = focusIntent.current;
    if (!intent) return;
    focusIntent.current = null;
    const el = document.getElementById(
      `block-input-${intent.id}`,
    ) as HTMLTextAreaElement | null;
    if (!el) return;
    // preventScroll, then scroll deliberately: focusing a long previous block
    // on a merge otherwise yanks the page to its top and loses the reader.
    el.focus({ preventScroll: true });
    const caret = intent.caret === CARET_END ? el.value.length : intent.caret;
    el.setSelectionRange(caret, caret);
    el.scrollIntoView({ block: 'nearest' });
  });

  const handleChange = useCallback(
    (index: number, text: string) => {
      const next = blocks.slice();
      next[index] = { ...next[index], text };
      onChange(next, false);
    },
    [blocks, onChange],
  );

  const handleSetKind = useCallback(
    (index: number, kind: BlockKind) => {
      const next = blocks.slice();
      next[index] = { ...next[index], kind };
      onChange(next, true);
      focusIntent.current = { id: next[index].id, caret: CARET_END };
    },
    [blocks, onChange],
  );

  const handleMove = useCallback(
    (index: number, delta: -1 | 1) => {
      const next = moveBlock(blocks, index, delta);
      if (next === blocks) return;
      onChange(next, true);
      focusIntent.current = { id: blocks[index].id, caret: CARET_END };
    },
    [blocks, onChange],
  );

  const handleDelete = useCallback(
    (index: number) => {
      const next = blocks.filter((_, i) => i !== index);
      // Never leave the document with nowhere to type.
      onChange(next.length > 0 ? next : [newBlock()], true);
      const focus = next[index - 1] ?? next[0];
      if (focus) focusIntent.current = { id: focus.id, caret: CARET_END };
    },
    [blocks, onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => {
      const el = event.currentTarget;
      const block = blocks[index];

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const result = splitAt(blocks, index, el.selectionStart);
        onChange(result.blocks, true);
        focusIntent.current = { id: result.focusId, caret: result.focusCaret };
        return;
      }

      if (
        event.key === 'Backspace' &&
        el.selectionStart === 0 &&
        el.selectionEnd === 0
      ) {
        const result = mergeBackward(blocks, index);
        if (result.kind === 'noop') return;
        event.preventDefault();
        if (result.kind === 'focus-previous') {
          focusIntent.current = { id: result.focusId, caret: result.focusCaret };
          return;
        }
        onChange(result.blocks, true);
        focusIntent.current = { id: result.focusId, caret: result.focusCaret };
        return;
      }

      // The shortcut everyone already knows from VS Code and Notion, and the
      // one a sighted keyboard user will actually find.
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        handleMove(index, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }

      // Flag without leaving the keyboard. The gutter button is the
      // discoverable path; this is the one used forty times over a season.
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onToggleFlag(block);
        return;
      }

      // Caret-POSITION based rather than caret-geometry based. Inside a wrapped
      // paragraph the first ArrowUp goes to offset 0 (the browser's own
      // behaviour) and the second leaves the block: one extra keypress, and
      // completely predictable. Doing it properly needs a mirror element per
      // block re-measured on every resize and font load.
      if (event.key === 'ArrowUp' && el.selectionStart === 0 && index > 0) {
        event.preventDefault();
        focusIntent.current = { id: blocks[index - 1].id, caret: CARET_END };
        return;
      }
      if (
        event.key === 'ArrowDown' &&
        el.selectionStart === el.value.length &&
        index < blocks.length - 1
      ) {
        event.preventDefault();
        focusIntent.current = { id: blocks[index + 1].id, caret: 0 };
      }
    },
    [blocks, onChange, onToggleFlag, handleMove],
  );

  return (
    <div className="space-y-0.5" onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    }}>
      {blocks.map((block, index) => (
        <BlockRow
          key={block.id}
          block={block}
          index={index}
          total={blocks.length}
          flagged={flaggedIds.has(block.id)}
          readOnly={readOnly}
          upload={uploads[block.id]}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onToggleFlag={onToggleFlag}
          onSetKind={handleSetKind}
          onMove={handleMove}
          onDelete={handleDelete}
          onRetryUpload={onRetryUpload}
        />
      ))}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const created = newBlock();
              onChange([...blocks, created], true);
              focusIntent.current = { id: created.id, caret: 0 };
            }}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 flex-1 items-center gap-1.5 rounded pl-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <ChevronDown className="size-4" aria-hidden />
            Add a note
          </button>

          {/* Paste is the desktop path and drop is the mouse one. This is the
              path that actually gets used on a pit-day phone, where there is a
              camera and no clipboard worth speaking of. */}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 items-center gap-1.5 rounded px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <ImagePlus className="size-4" aria-hidden />
            Add a photo
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length > 0) void insertImages(files);
              // Reset, or picking the same photo twice in a row does nothing.
              event.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
