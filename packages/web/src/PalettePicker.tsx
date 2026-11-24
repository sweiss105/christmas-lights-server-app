import { useEffect, useMemo, useRef, useState } from 'react';
import { PALETTE_NAMES, WLED_PALETTE_NAMES, paletteColors } from '@xmas/engine';

/** CSS gradient for a palette, using the layer's colours for the colour-based palettes. */
export function paletteGradient(name: string, params: Record<string, unknown> = {}): string {
  const c = paletteColors(name, params, 12);
  return `linear-gradient(90deg, ${c.map((x, i) => `${x} ${Math.round((i / (c.length - 1)) * 100)}%`).join(', ')})`;
}

/** Palette choice with a gradient preview of every palette, WLED's first, then our own. */
export function PalettePicker({ label, value, params, onChange }: { label: string; value: string; params: Record<string, unknown>; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const pop = useRef<HTMLDivElement>(null);
  // The picker usually sits low in the scrolling editor panel: bring the open list fully into view.
  useEffect(() => { if (open) pop.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [open]);
  const wled = new Set(WLED_PALETTE_NAMES);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const names = PALETTE_NAMES.filter((n) => !q || n.toLowerCase().includes(q));
    return [
      { title: 'WLED', names: names.filter((n) => wled.has(n)) },
      { title: 'Built-in', names: names.filter((n) => !wled.has(n)) },
    ].filter((g) => g.names.length);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="field palette-field" ref={root}>
      <span className="field-label">{label}</span>
      <button className="palette-current" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value}`} onClick={() => setOpen((o) => !o)}>
        <span className="palette-strip" style={{ background: paletteGradient(value, params) }} aria-hidden />
        <span className="palette-name">{value.replace(/^\* /, '')}</span>
      </button>
      {open && (
        <div ref={pop} className="palette-pop" role="dialog" aria-label={`Choose ${label}`} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          <input className="search" type="search" autoFocus placeholder="Search palettes" aria-label="Search palettes" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="palette-list" role="listbox" aria-label="Palettes">
            {groups.map((g) => (
              <section key={g.title}>
                <h4 className="picker-group">{g.title}<span>{g.names.length}</span></h4>
                {g.names.map((n) => (
                  <button key={n} role="option" aria-selected={n === value} className={`palette-option ${n === value ? 'selected' : ''}`}
                    onClick={() => { onChange(n); setOpen(false); }}>
                    <span className="palette-strip" style={{ background: paletteGradient(n, params) }} aria-hidden />
                    <span className="palette-name">{n.replace(/^\* /, '')}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
