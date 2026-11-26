import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO, DEMO_TIP } from './demo/flag';
import { builtinPaletteStops, PALETTE_NAMES, WLED_PALETTE_NAMES, paletteColors, paletteStopsFor, type PaletteStop, type SavedPalette } from '@xmas/engine';
import { api } from './api';

/** CSS gradient for a palette, using the layer's colours for the colour-based palettes and its own stops for edited ones. */
export function paletteGradient(name: string, params: Record<string, unknown> = {}): string {
  const c = paletteColors(name, params, 12);
  return `linear-gradient(90deg, ${c.map((x, i) => `${x} ${Math.round((i / (c.length - 1)) * 100)}%`).join(', ')})`;
}

/** A layer's palette and, for an edited or saved one, its colours (params `palette` and `paletteStops`). */
export interface PalettePatch { palette: string; paletteStops: PaletteStop[] | undefined }

const EDITED = ' (edited)';
const baseName = (n: string) => (n.endsWith(EDITED) ? n.slice(0, -EDITED.length) : n);
const BUILTIN = new Set(PALETTE_NAMES);
const sameStops = (a: readonly PaletteStop[], b: readonly PaletteStop[]) => a.length === b.length && a.every((s, i) => s[0] === b[i]![0] && s[1] === b[i]![1]);

/** Stops grouped into runs of one colour (a flat stretch, or a hard-edged band), each shown as one swatch. */
function colourRuns(stops: readonly PaletteStop[]): number[][] {
  const runs: number[][] = [];
  stops.forEach((s, i) => {
    if (i > 0 && s[1] === stops[i - 1]![1]) runs.at(-1)!.push(i);
    else runs.push([i]);
  });
  return runs;
}

/** Palette choice with a gradient preview of every palette: the show's saved ones, WLED's, then our own. */
export function PalettePicker({ label, value, params, saved, onPick }: {
  label: string; value: string; params: Record<string, unknown>; saved: SavedPalette[]; onPick: (p: PalettePatch) => void;
}) {
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
  const groups = useMemo(() => {
    const wled = new Set(WLED_PALETTE_NAMES);
    const q = query.trim().toLowerCase();
    const match = (n: string) => !q || n.toLowerCase().includes(q);
    const names = PALETTE_NAMES.filter(match);
    return [
      { title: 'My palettes', items: saved.filter((p) => match(p.name)).map((p) => ({ name: p.name, stops: p.stops as PaletteStop[] | undefined })) },
      { title: 'WLED', items: names.filter((n) => wled.has(n)).map((name) => ({ name, stops: undefined })) },
      { title: 'Built-in', items: names.filter((n) => !wled.has(n)).map((name) => ({ name, stops: undefined })) },
    ].filter((g) => g.items.length);
  }, [query, saved]);

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
                <h4 className="picker-group">{g.title}<span>{g.items.length}</span></h4>
                {g.items.map(({ name, stops }) => (
                  <button key={name} role="option" aria-selected={name === value} className={`palette-option ${name === value ? 'selected' : ''}`}
                    onClick={() => { onPick({ palette: name, paletteStops: stops && structuredClone(stops) }); setOpen(false); }}>
                    <span className="palette-strip" style={{ background: paletteGradient(name, stops ? { ...params, paletteStops: stops } : params) }} aria-hidden />
                    <span className="palette-name">{name.replace(/^\* /, '')}</span>
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

/**
 * The palette picker plus the selected palette's colours: tap one to change it. Changing a colour makes
 * the layer's palette an edited copy ("Party (edited)") kept with the layer; Reset goes back to the
 * original, and "Save as palette" names the copy so other layers and scenes can pick it.
 */
export function PaletteControl({ label, value, params, saved, onPatch, onEnd, onSavedChange, reportError }: {
  label: string; value: string; params: Record<string, unknown>; saved: SavedPalette[];
  /** `merge`: part of a continuous gesture (dragging in the colour picker), one undo step until onEnd. */
  onPatch: (p: PalettePatch, merge: boolean) => void;
  onEnd: () => void;
  /** Reload the saved palettes after this control changed them. */
  onSavedChange: () => Promise<void>;
  reportError: (e: unknown) => void;
}) {
  const byName = useMemo(() => Object.fromEntries(saved.map((p) => [p.name, p])), [saved]);
  const stops = paletteStopsFor(value, params, byName);
  const builtin = BUILTIN.has(value);
  const base = baseName(value);
  const savedHere = !builtin && Object.hasOwn(byName, value) ? byName[value]! : null;
  const savedBase = !BUILTIN.has(base) && Object.hasOwn(byName, base) ? byName[base]! : null;
  const original = BUILTIN.has(base) ? builtinPaletteStops(base) : savedBase?.stops ?? null;
  const canReset = !builtin && value.endsWith(EDITED) && !!original;
  const isSaved = !!savedHere && !!stops && sameStops(savedHere.stops, stops);
  // Group by the original's colour runs while editing, so swatches don't merge or split as colours change.
  const runs = useMemo(() => (stops ? colourRuns(original && original.length === stops.length ? original : stops) : []), [stops, original]);
  const [naming, setNaming] = useState<null | 'save' | 'rename'>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNaming(null); }, [value]);

  const change = (run: number[], color: string) => {
    if (!stops) return;
    const next = stops.map((s, i): PaletteStop => (run.includes(i) ? [s[0], color] : [s[0], s[1]]));
    const palette = builtin || (savedHere && !value.endsWith(EDITED)) ? `${value}${EDITED}` : value;
    onPatch({ palette, paletteStops: next }, true);
  };
  const reset = () => {
    if (BUILTIN.has(base)) onPatch({ palette: base, paletteStops: undefined }, false);
    else if (savedBase) onPatch({ palette: base, paletteStops: structuredClone(savedBase.stops) }, false);
  };
  const startNaming = (kind: 'save' | 'rename') => {
    setName(kind === 'rename' ? value : savedBase ? base : BUILTIN.has(base) ? `My ${base}` : base);
    setNaming(kind);
  };
  const commit = async () => {
    const n = name.trim();
    if (!n || !stops) { setNaming(null); return; }
    if (BUILTIN.has(n) || n.startsWith('* ')) { reportError(new Error(`“${n}” is the name of a built-in palette. Choose another name.`)); return; }
    if (naming === 'rename' && n === value) { setNaming(null); return; }
    if (naming === 'save' && Object.hasOwn(byName, n) && !window.confirm(`Replace the palette “${n}”?`)) return;
    setBusy(true);
    try {
      if (naming === 'rename') await api.renamePalette(value, n);
      else await api.savePalette(n, stops);
      await onSavedChange();
      onPatch({ palette: n, paletteStops: structuredClone(stops) }, false);
      setNaming(null);
    } catch (e) { reportError(e); }
    setBusy(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete the palette “${value}”? Layers that use it keep its colours.`)) return;
    try { await api.deletePalette(value); await onSavedChange(); } catch (e) { reportError(e); }
  };

  return (
    <>
      <PalettePicker label={label} value={value} params={params} saved={saved} onPick={(p) => onPatch(p, false)} />
      {stops && (
        <div className="palette-edit">
          <div className="palette-swatches" role="group" aria-label={`Colours of ${value}`}>
            {runs.map((run, k) => {
              const color = stops[run[0]!]![1];
              return (
                <label key={k} className="pal-swatch" style={{ background: color }} title={`Change colour ${k + 1} (${color.toUpperCase()})`}>
                  <input type="color" value={color} aria-label={`Palette colour ${k + 1} of ${runs.length}`}
                    onChange={(e) => change(run, e.target.value.toLowerCase())} onBlur={onEnd} />
                </label>
              );
            })}
          </div>
          {naming ? (
            <div className="preset-bar palette-actions">
              <input className="title-input small" autoFocus value={name} maxLength={60} placeholder="Palette name" aria-label="Palette name"
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setNaming(null); }} />
              <button className="btn small" disabled={busy || !name.trim()} onClick={() => void commit()}>{naming === 'rename' ? 'Rename' : 'Save'}</button>
              <button className="btn small ghost" onClick={() => setNaming(null)}>Cancel</button>
            </div>
          ) : (
            <div className="preset-bar palette-actions">
              {!builtin && !isSaved && <button className="btn small" disabled={DEMO} title={DEMO ? DEMO_TIP : undefined} onClick={() => startNaming('save')}>Save as palette</button>}
              {canReset && <button className="btn small ghost" onClick={reset} title={`Back to ${base}`}>Reset</button>}
              {isSaved && <button className="btn small ghost" disabled={DEMO} title={DEMO ? DEMO_TIP : undefined} onClick={() => startNaming('rename')}>Rename</button>}
              {isSaved && <button className="btn small ghost danger-quiet" disabled={DEMO} title={DEMO ? DEMO_TIP : undefined} onClick={() => void remove()}>Delete</button>}
              {builtin && <span className="hint-inline">Tap a colour to change it</span>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
