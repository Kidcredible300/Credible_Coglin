/**
 * The note document, as pure functions.
 *
 * Everything here is deliberately free of React and of the network, because the
 * fiddly parts of a block editor — where the caret lands after a split, what a
 * merge does to a flag, which kind an Enter continues into — are the parts most
 * worth being able to reason about (and later test) on their own.
 *
 * The editor's local state is authoritative while a meeting is open. The server
 * is a durable log that catches up, not the source of truth for what the
 * student is currently looking at.
 */
import type { BlockKind, NoteBlock } from '@/types';

export const POSITION_GAP = 1024;

/** Caret sentinel meaning "the end of whatever text ends up here". */
export const CARET_END = -1;

export interface DraftBlock {
  id: string;
  kind: BlockKind;
  text: string;
  media_id: string | null;
  /** Absent until the first save round-trips; local-only blocks still render. */
  saved?: boolean;
}

export function toDraft(block: NoteBlock): DraftBlock {
  return {
    id: block.id,
    kind: block.kind,
    text: block.text,
    media_id: block.media_id,
    saved: true,
  };
}

export function newBlock(
  kind: BlockKind = 'paragraph',
  text = '',
  mediaId: string | null = null,
): DraftBlock {
  // The id is minted here rather than by the server so a student can flag a
  // paragraph the instant they type it, without waiting for a round trip.
  return { id: crypto.randomUUID(), kind, text, media_id: mediaId, saved: false };
}

/**
 * What Enter continues into.
 *
 * A heading or a decision is a one-off — you write one and move on. A bullet or
 * an action item is a list you are in the middle of, so Enter should keep you
 * in it.
 */
export function continuationKind(kind: BlockKind): BlockKind {
  return kind === 'bullet' || kind === 'action' ? kind : 'paragraph';
}

/** Kinds that hold text a student types (everything except an image). */
export function isTextKind(kind: BlockKind): boolean {
  return kind !== 'image';
}

export const BLOCK_KIND_LABELS: { id: BlockKind; label: string; hint: string }[] = [
  { id: 'paragraph', label: 'Text', hint: 'Plain note' },
  { id: 'heading', label: 'Heading', hint: 'Section title' },
  { id: 'bullet', label: 'Bullet', hint: 'List item' },
  { id: 'decision', label: 'Decision', hint: 'What we chose, and why' },
  { id: 'action', label: 'Action item', hint: 'Something to do' },
];

export const PLACEHOLDER: Record<BlockKind, string> = {
  heading: 'Section',
  paragraph: 'Start typing…',
  bullet: 'List item',
  // Named for the award it feeds. "What we tried, why we changed it" is the
  // Think submission's raw material, and phrasing the placeholder as the
  // question is the cheapest way to get it written down at the time.
  decision: 'What did we decide, and why?',
  action: 'Who is doing what?',
  image: 'Caption (optional)',
};

/**
 * Split a block at the caret.
 *
 * Returns the whole new list plus which block should take focus. Enter on an
 * empty non-paragraph block escapes the styling instead of adding another empty
 * row — every editor a student has used behaves that way, and without it the
 * only way out of a bullet list is a toolbar nobody looks for.
 */
export function splitAt(
  blocks: DraftBlock[],
  index: number,
  caret: number,
): { blocks: DraftBlock[]; focusId: string; focusCaret: number } {
  const block = blocks[index];
  const before = block.text.slice(0, caret);
  const after = block.text.slice(caret);

  if (before === '' && after === '' && block.kind !== 'paragraph') {
    const next = blocks.slice();
    next[index] = { ...block, kind: 'paragraph' };
    return { blocks: next, focusId: block.id, focusCaret: 0 };
  }

  const created = newBlock(continuationKind(block.kind), after);
  const next = blocks.slice();
  next[index] = { ...block, text: before };
  next.splice(index + 1, 0, created);
  return { blocks: next, focusId: created.id, focusCaret: 0 };
}

/**
 * Backspace at the very start of a block.
 *
 * Un-styles first and merges only on a second press, so the first keystroke is
 * always reversible. An image absorbs nothing — the caret moves onto it — since
 * losing a pit photo to a held-down Backspace is not forgiven.
 */
export function mergeBackward(
  blocks: DraftBlock[],
  index: number,
):
  | { kind: 'unstyled'; blocks: DraftBlock[]; focusId: string; focusCaret: number }
  | { kind: 'merged'; blocks: DraftBlock[]; focusId: string; focusCaret: number; removedId: string }
  | { kind: 'focus-previous'; focusId: string; focusCaret: number }
  | { kind: 'noop' } {
  const block = blocks[index];

  if (block.kind !== 'paragraph' && block.kind !== 'image') {
    const next = blocks.slice();
    next[index] = { ...block, kind: 'paragraph' };
    return { kind: 'unstyled', blocks: next, focusId: block.id, focusCaret: 0 };
  }

  const previous = blocks[index - 1];
  if (!previous) return { kind: 'noop' };

  if (previous.kind === 'image' || block.kind === 'image') {
    return { kind: 'focus-previous', focusId: previous.id, focusCaret: CARET_END };
  }

  const next = blocks.slice();
  next[index - 1] = { ...previous, text: previous.text + block.text };
  next.splice(index, 1);
  return {
    kind: 'merged',
    blocks: next,
    focusId: previous.id,
    focusCaret: previous.text.length,
    removedId: block.id,
  };
}

/** Move a block one step, for the keyboard alternative to dragging. */
export function moveBlock(
  blocks: DraftBlock[],
  index: number,
  delta: -1 | 1,
): DraftBlock[] {
  const target = index + delta;
  if (target < 0 || target >= blocks.length) return blocks;
  const next = blocks.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Serialize to plain text.
 *
 * The single most-used export in practice: teams live in Discord, and a recap
 * pasted into a channel is what actually gets read. Also the answer to the one
 * real cost of separate textareas — you cannot select across blocks, so this
 * button does the selecting for you.
 */
export function toPlainText(blocks: DraftBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return `\n## ${block.text}`;
        case 'bullet':
          return `- ${block.text}`;
        case 'decision':
          return `> Decision: ${block.text}`;
        case 'action':
          return `[ ] ${block.text}`;
        case 'image':
          return block.text ? `(photo: ${block.text})` : '(photo)';
        default:
          return block.text;
      }
    })
    .join('\n')
    .trim();
}

/** True when the document holds nothing a person actually wrote. */
export function isEmptyDocument(blocks: DraftBlock[]): boolean {
  return blocks.every((b) => b.kind !== 'image' && b.text.trim() === '');
}
