// Fixed strings only (no user data), so inserting them as SVG markup is safe.
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  hold: '<path d="M9 6v12M15 6v12"/>',
  spin: '<path d="M12 3a9 9 0 019 9"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.5-4.5M4 5v4h4M4 13a8 8 0 0014.5 4.5M20 19v-4h-4"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 016 0v3"/>',
  unlock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 015.6-1.5"/>',
  clock: '<path d="M12 6v6l4 2"/>',
  dash: '<path d="M7 12h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  circleok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  list: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  board: '<rect x="4" y="4" width="6" height="16" rx="1.5"/><rect x="14" y="4" width="6" height="10" rx="1.5"/>',
  back: '<path d="M10 6l-6 6 6 6M4 12h16"/>',
  pulls: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 00-3-3h-3m0 0l2.5-2.5M12 6l2.5 2.5"/>',
  brand: '<path d="M5 20V5M19 20V5M5 12h14"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <span className={`ic ${className}`.trim()} aria-hidden="true"><svg viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICONS[name] }} /></span>;
}
