/** Line icons (inline SVG, so they follow the text colour). */

const P20 = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const P16 = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

/** Tool icons, as in the rail. */
export const TOOL_ICONS = {
  move: 'M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5',
  select: 'M3 3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M3 7V3',
  /** A paintbrush: rounded handle, ferrule, and the bristles drawn to a tip (bottom left). */
  brush: 'M12.85 8.85 17.65 4.05a1.2 1.2 0 0 0-1.7-1.7L11.15 7.15M13.27 9.27l-2 2-2.54-2.54 2-2zM11.27 11.27C10.5 14.5 7 17 3 17c0-4 2.5-7.5 5.73-8.27',
  erase: 'M8 17h9M4 13l7-8 6 6-6 6H8z',
  strings: 'M3 15c3-8 11-8 14 0M3 15h2M15 15h2M10 7v2',
  house: 'M3 10l7-6 7 6M5 9v8h10V9M8 17v-4h4v4',
  map: 'M3 7h3l1.5-2h5L14 7h3v9H3zM10 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  wled: 'M3 5h14v10H3zM6 15v2M14 15v2M6 9h2M10 9h4',
  backups: 'M4 6h12v10H4zM4 6l2-3h8l2 3M8 10h4',
  home: 'M3 9.5 10 3.5l7 6M5 8.5V17h10V8.5M8.5 13.5a2 2 0 0 1 3 0M7 11.5a4.5 4.5 0 0 1 6 0',
} as const;
export type ToolIconName = keyof typeof TOOL_ICONS;
export const ToolIcon = ({ name }: { name: ToolIconName }) => <P20 d={TOOL_ICONS[name]} />;

export const MoreIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden><circle cx="4" cy="9" r="1.5" /><circle cx="9" cy="9" r="1.5" /><circle cx="14" cy="9" r="1.5" /></svg>
);
export const ChevronDown = () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="m2 4 3 3 3-3" /></svg>;
export const CameraViewIcon = () => <P16 d="M2 5h8v6H2zM10 7l4-2v6l-4-2" />;
export const PeekIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" />
  </svg>
);
export const FullScreenIcon = () => <P16 d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />;
export const PencilIcon = () => <P16 d="M10.5 2.5l3 3L6 13H3v-3z" size={15} />;
export const PlusIcon = () => <P16 d="M8 3v10M3 8h10" size={14} />;
export const DuplicateIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /><path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" /></svg>
);
export const TrashIcon = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.7 7.5h5.6L10.5 4" /></svg>;
export const RevertIcon = () => <P16 d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" />;
export const UndoIcon = () => <P16 d="M6 4 3 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H8" />;
export const RedoIcon = () => <P16 d="m10 4 3 3-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H8" />;
export const SearchIcon = () => <P16 d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M10.5 10.5 14 14" size={14} />;
/** Six dots: the handle that drags a pop-out. */
export const GripIcon = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
    <circle cx="3" cy="3" r="1.2" /><circle cx="7" cy="3" r="1.2" /><circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="3" cy="11" r="1.2" /><circle cx="7" cy="11" r="1.2" />
  </svg>
);
export const CloseIcon = () => <P16 d="M4 4l8 8M12 4l-8 8" size={14} />;
export const StopIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
export const PlayIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 2v8l7-4z" fill="currentColor" /></svg>;
/** Show or hide the side panel: a window with its right-hand panel filled in when it's shown. */
export const PanelIcon = ({ shown }: { shown: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
    <path d="M12.5 3.5v13" />
    {shown && <rect x="13.5" y="4.5" width="3" height="11" rx="1" fill="currentColor" stroke="none" />}
  </svg>
);
