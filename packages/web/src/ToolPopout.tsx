import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CloseIcon, GripIcon } from './icons';

/**
 * A tool's settings, in a small window that opens beside its rail button (as in Photoshop's tool
 * flyouts). It stays open while the 3D view is used under it. Its header drags it anywhere in the
 * window (remembered per tool on this device); a double-click on the header puts it back beside the
 * rail. On a phone it is a compact sheet just above the tool strip, and doesn't move.
 */
export function ToolPopout({ id, title, subtitle, phone, onClose, children }: {
  id: string; title: string; subtitle?: React.ReactNode; phone: boolean; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [moved, setMoved] = useMovedTo(id);
  const [place, setPlace] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number; pointer: number; at?: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Where it goes: where it was dragged to, or beside its rail button; always wholly inside the window. */
  const placeIt = useCallback((want?: { x: number; y: number } | null) => {
    const el = ref.current;
    if (!el || phone) return;
    const m = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
    const below = topbar ? topbar.bottom + 12 : m;
    const target = want === undefined ? drag.current?.at ?? moved : want;
    const w = el.offsetWidth;
    // Its full height; a tall one scrolls inside itself rather than climbing up the screen, down to `least`.
    const full = ((el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0) + (el.lastElementChild?.scrollHeight ?? 0) + 2;
    const least = Math.min(full, 360);
    let left: number, want0: number, ceiling: number, floor: number;
    if (target) {
      left = target.x; want0 = target.y; ceiling = m; floor = vh - m;
    } else {
      // Beside the rail, top-aligned with the tool's button, between the top bar and the status card below.
      const rail = document.querySelector('.rail')?.getBoundingClientRect();
      const btn = document.querySelector(`.rail-btn[data-tool="${id}"]`)?.getBoundingClientRect();
      left = (rail?.right ?? m) + 8;
      const health = document.querySelector('.health')?.getBoundingClientRect();
      floor = health && health.width > 0 && health.right > left && health.left < left + w ? health.top - 8 : vh - 12;
      want0 = btn?.top ?? below; ceiling = below;
    }
    left = Math.max(m, Math.min(left, vw - w - m));
    let top = Math.max(ceiling, Math.min(want0, floor - least));
    top = Math.max(m, Math.min(top, vh - m - least));
    const maxH = Math.max(120, Math.min(full, floor - top, vh - m - top));
    setPlace((p) => (p && p.left === left && p.top === top && p.maxH === maxH ? p : { left, top, maxH }));
  }, [id, moved, phone]);

  useLayoutEffect(() => { placeIt(); }, [placeIt]);
  useEffect(() => {
    if (phone) return;
    const on = () => placeIt();
    const ro = new ResizeObserver(on);
    if (ref.current) ro.observe(ref.current);
    const content = ref.current?.lastElementChild?.firstElementChild; // the settings grow (a new group) or shrink
    if (content) ro.observe(content);
    const rail = document.querySelector('.rail');
    if (rail) ro.observe(rail);
    window.addEventListener('resize', on);
    return () => { ro.disconnect(); window.removeEventListener('resize', on); };
  }, [placeIt, phone]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    close();
  };
  /** Close, and hand the keyboard back to the tool's rail button. */
  const close = () => {
    const btn = document.querySelector<HTMLElement>(`.rail-btn[data-tool="${id}"]`);
    if (ref.current?.contains(document.activeElement)) btn?.focus();
    onClose();
  };

  const startDrag = (e: React.PointerEvent) => {
    if (phone || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const r = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, pointer: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    d.at = { x: e.clientX - d.dx, y: e.clientY - d.dy };
    placeIt(d.at);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!d.at) return; // a click on the header, not a drag
    const r = ref.current!.getBoundingClientRect();
    setMoved({ x: Math.round(r.left), y: Math.round(r.top) });
  };

  const style = phone || !place ? undefined : { left: place.left, top: place.top, maxHeight: place.maxH };
  return (
    <section ref={ref} className={`tool-pop glass ${dragging ? 'dragging' : ''}`} role="dialog" aria-modal="false" aria-label={`${title} settings`} id={`tool-pop-${id}`}
      style={style} onKeyDown={onKeyDown}>
      <div className="tool-pop-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={(e) => { if (!phone && !(e.target as HTMLElement).closest('button')) setMoved(null); }}
        title={phone ? undefined : 'Drag to move · double-click to put it back by the tools'}>
        {!phone && <span className="tool-pop-grip" aria-hidden><GripIcon /></span>}
        <div className="tool-pop-title">
          <h2>{title}</h2>
          {subtitle && <span className="tool-pop-sub">{subtitle}</span>}
        </div>
        <button className="icon-btn small tool-pop-close" aria-label={`Close the ${title} settings`} title="Close (Esc)" onClick={close}><CloseIcon /></button>
      </div>
      <div className="tool-pop-body">{children}</div>
    </section>
  );
}

/** Where a tool's pop-out was dragged to on this device (null: beside the rail). */
function useMovedTo(id: string): [{ x: number; y: number } | null, (p: { x: number; y: number } | null) => void] {
  const key = `xmas.popout.at.${id}`;
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { x?: unknown; y?: unknown } | null;
      return v && typeof v.x === 'number' && typeof v.y === 'number' ? { x: v.x, y: v.y } : null;
    } catch { return null; }
  };
  const [at, setAt] = useState(read);
  useEffect(() => setAt(read()), [key]);
  const set = (p: { x: number; y: number } | null) => {
    setAt(p);
    try { if (p) localStorage.setItem(key, JSON.stringify(p)); else localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return [at, set];
}

/** Which tools' pop-outs are open, remembered on this device (open until closed). */
export function usePopoutsOpen() {
  const KEY = 'xmas.popout.open';
  const [open, setOpenMap] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const isOpen = (tool: string) => open[tool] !== false;
  const setOpen = (tool: string, v: boolean) => {
    setOpenMap((m) => {
      const next = { ...m, [tool]: v };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };
  return { isOpen, setOpen };
}
