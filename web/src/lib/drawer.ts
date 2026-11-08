import type { PullBrief } from '../types';

// The ticket drawer (open a ticket, create a ticket) can be opened from several screens.
// They call these functions, and <DrawerHost /> in App shows it.
export type DrawerReq = { kind: 'ticket'; id: number } | { kind: 'create'; defaultPr: string; pulls: PullBrief[] };

let show: (r: DrawerReq | null) => void = () => {};
export const bindDrawer = (fn: (r: DrawerReq | null) => void) => { show = fn; };
export const openTicket = (id: number) => show({ kind: 'ticket', id });
export const openCreate = (defaultPr: string, pulls: PullBrief[]) => show({ kind: 'create', defaultPr, pulls });
export const closeDrawer = () => show(null);
