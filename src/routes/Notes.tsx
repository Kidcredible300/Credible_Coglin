import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';

/**
 * Notes: a tree of documents, some belonging to a meeting and some standing on
 * their own.
 *
 * Placeholder shell. The document tree, the TipTap editor and the drag targets
 * land next; this exists now so the nav entry and the /notes routes are real
 * rather than falling through to the catch-all, which would tell a coach the
 * section is unbuilt in copy meant for Awards and Budget.
 */
export default function Notes() {
  return (
    <>
      <PageHeader title="Notes" />
      <div className="px-4 py-6 md:px-8">
        <EmptyState
          title="No notes yet."
          aside="A document can stand on its own or belong to a meeting. Everything you type is saved as you go."
        />
      </div>
    </>
  );
}
