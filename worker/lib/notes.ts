/**
 * Note documents: the vocabulary, the bounds, and the content validator.
 *
 * No DB access and no Hono — the same split lib/meetings.ts keeps, so the parts
 * that are pure arithmetic and pure vocabulary can be reasoned about without a
 * request in scope.
 */

// ---------------------------------------------------------------------- bounds

/** One document. Past this it is a chapter, not a page. */
export const MAX_CONTENT_BYTES = 200_000;
export const MAX_TITLE = 200;
/** Documents per team per season. */
export const MAX_DOCS = 2_000;
/** Tree depth. Confluence stops being navigable well before this. */
export const MAX_DEPTH = 8;
/** Documents moved by one reparent, i.e. the size of a subtree. */
export const MAX_SUBTREE = 200;
/** Nodes in one document, so a hostile body cannot wedge the client renderer. */
export const MAX_NODES = 5_000;
/** Nesting depth WITHIN a document, which is a different thing from tree depth. */
export const MAX_NODE_DEPTH = 24;

// ------------------------------------------------------------ the doc schema

/**
 * The server's copy of the editor schema.
 *
 * Values first and the type derived, exactly as lib/meetings.ts explains: a
 * hand-written union beside a separate array drifted once and cost a 400 that
 * nobody could reproduce.
 *
 * The Worker has no ProseMirror schema to validate against, so an unknown node
 * type would round-trip into every future reader forever. `content` has no FK and
 * no CHECK, which makes validating it the Worker's job for the same reason
 * routes/candidates.ts validates a polymorphic source_id.
 */
export const DOC_NODE_TYPES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'mediaImage',
] as const;
export type DocNodeType = (typeof DOC_NODE_TYPES)[number];

const NODE_TYPES: ReadonlySet<string> = new Set(DOC_NODE_TYPES);

export interface JsonNode {
  type: string;
  text?: string;
  content?: JsonNode[];
  attrs?: Record<string, unknown>;
  marks?: unknown[];
}

export type ContentError =
  | 'invalid_content'
  | 'content_too_large'
  | 'too_many_nodes';

/**
 * Validate a document body and derive its plain text in one walk.
 *
 * Returns either the parsed doc plus its text projection, or a single error code.
 * One function so `content` and `content_text` cannot disagree: they are produced
 * from the same traversal, and the route writes both or neither.
 */
export function parseContent(
  value: unknown,
): { doc: JsonNode; text: string } | { error: ContentError } {
  if (typeof value !== 'string') return { error: 'invalid_content' };
  // Bytes, not characters. An emoji-heavy document is bigger than its length.
  if (new TextEncoder().encode(value).length > MAX_CONTENT_BYTES) {
    return { error: 'content_too_large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: 'invalid_content' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'invalid_content' };
  }
  const doc = parsed as JsonNode;
  if (doc.type !== 'doc') return { error: 'invalid_content' };

  const parts: string[] = [];
  let nodes = 0;

  // Iterative, not recursive: a hand-forged 10,000-deep body would blow the
  // stack, and a RangeError is a 500 where this should be a 400.
  const stack: { node: JsonNode; depth: number }[] = [{ node: doc, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      return { error: 'invalid_content' };
    }
    if (!NODE_TYPES.has(node.type)) return { error: 'invalid_content' };
    if (depth > MAX_NODE_DEPTH) return { error: 'invalid_content' };
    if (++nodes > MAX_NODES) return { error: 'too_many_nodes' };

    if (node.type === 'text') {
      if (typeof node.text !== 'string') return { error: 'invalid_content' };
      parts.push(node.text);
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return { error: 'invalid_content' };
      // Reversed so the text projection comes out in document order despite the
      // stack. Getting this wrong makes every excerpt read backwards.
      for (let i = node.content.length - 1; i >= 0; i--) {
        stack.push({ node: node.content[i] as JsonNode, depth: depth + 1 });
      }
    }
    // A block boundary is a space, so "Chassis" and "notes" do not become
    // "Chassisnotes" in an excerpt or a LIKE.
    if (node.type !== 'text' && node.type !== 'doc') parts.push(' ');
  }

  return { doc, text: parts.join('').replace(/\s+/g, ' ').trim() };
}

/** An empty document, so a freshly created page has somewhere to put the caret. */
export function emptyDoc(): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
}
