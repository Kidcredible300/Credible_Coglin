import {
  ClipboardList,
  Coins,
  FileText,
  Home,
  Megaphone,
  MessagesSquare,
  NotebookPen,
  Trophy,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Primary items get a slot in the mobile tab bar; the rest live in the sheet. */
  primary?: boolean;
  /**
   * Nothing can be created here yet. Marked so the nav says "soon" rather than
   * letting a coach walk into a screen that only ever shows an empty state.
   */
  stub?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Home, primary: true },
  { to: '/boards', label: 'Boards', icon: ClipboardList, primary: true },
  // Meetings takes the tab-bar slot Outreach had. A team meets two or three
  // times a week and logs outreach maybe twice a month, so this is the one that
  // earns a thumb position on a phone. The bar has exactly four slots — see the
  // note in AppShell — so taking one means giving one up.
  { to: '/meetings', label: 'Meetings', icon: MessagesSquare, primary: true },
  // Notes takes the tab-bar slot Roster had. A student opens notes at every
  // meeting; the roster is a September setup screen you rarely revisit. The
  // bar has exactly four slots — see the note in AppShell — so taking one
  // means giving one up, and this is the trade.
  { to: '/notes', label: 'Notes', icon: NotebookPen, primary: true },
  { to: '/roster', label: 'Roster', icon: Users },
  { to: '/outreach', label: 'Outreach', icon: Megaphone, stub: true },
  { to: '/awards', label: 'Awards', icon: Trophy, stub: true },
  { to: '/portfolio', label: 'Portfolio', icon: FileText },
  { to: '/budget', label: 'Budget', icon: Coins, stub: true },
];
