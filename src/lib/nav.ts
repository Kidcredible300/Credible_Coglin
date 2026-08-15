import {
  CalendarDays,
  ClipboardList,
  Coins,
  FileText,
  Home,
  Megaphone,
  MessagesSquare,
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
  /** Routed but not yet built — rendered as a stub screen. */
  stub?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Home, primary: true },
  { to: '/boards', label: 'Boards', icon: ClipboardList, primary: true },
  { to: '/outreach', label: 'Outreach', icon: Megaphone, primary: true },
  { to: '/roster', label: 'Roster', icon: Users, primary: true },
  { to: '/awards', label: 'Awards', icon: Trophy, stub: true },
  { to: '/portfolio', label: 'Portfolio', icon: FileText, stub: true },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, stub: true },
  { to: '/budget', label: 'Budget', icon: Coins, stub: true },
  { to: '/meetings', label: 'Meetings', icon: MessagesSquare, stub: true },
];
