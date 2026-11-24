import { useMemo, useRef, useEffect, useState } from 'react';
import { EFFECT_CATEGORIES, EFFECTS, type EffectDef } from '@xmas/engine';
import type { Preset } from './api';

interface Props {
  presets: Preset[];
  onPickEffect: (effectId: string) => void;
  onPickPreset: (preset: Preset) => void;
  onDeletePreset: (name: string) => void;
  onClose: () => void;
}

type Tab = 'effects' | 'presets';

const matches = (q: string, ...texts: (string | undefined)[]) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};

/** "Add layer": every effect grouped by category, or a saved preset. Searchable, as there are ~190 effects. */
export function LayerPicker({ presets, onPickEffect, onPickPreset, onDeletePreset, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('effects');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { search.current?.focus({ preventScroll: true }); }, [tab]);

  const groups = useMemo(() => {
    const all = Object.values(EFFECTS);
    return EFFECT_CATEGORIES
      .map((cat) => ({
        cat,
        items: all.filter((fx) => fx.category === cat && matches(query, fx.name, fx.description, fx.wled, fx.category)).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  const shownPresets = presets.filter((p) => matches(query, p.name, EFFECTS[p.effect]?.name));
  const effectCount = groups.reduce((a, g) => a + g.items.length, 0);

  return (
    <div className="picker" role="dialog" aria-label="Add a layer" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="picker-head">
        <div className="segmented" role="tablist" aria-label="Add from">
          <button role="tab" aria-selected={tab === 'effects'} className={tab === 'effects' ? 'active' : ''} onClick={() => setTab('effects')}>Effects</button>
          <button role="tab" aria-selected={tab === 'presets'} className={tab === 'presets' ? 'active' : ''} onClick={() => setTab('presets')}>Presets{presets.length ? ` (${presets.length})` : ''}</button>
        </div>
        <button className="icon-btn small" onClick={onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <input
        ref={search} className="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={tab === 'effects' ? 'Search effects' : 'Search presets'} aria-label={tab === 'effects' ? 'Search effects' : 'Search presets'}
      />

      {tab === 'effects' && (
        <div className="picker-list" role="listbox" aria-label="Effects">
          {groups.map((g) => (
            <section key={g.cat} aria-label={g.cat}>
              <h4 className="picker-group">{g.cat}<span>{g.items.length}</span></h4>
              {g.items.map((fx) => <EffectRow key={fx.id} fx={fx} onPick={() => onPickEffect(fx.id)} />)}
            </section>
          ))}
          {effectCount === 0 && <p className="empty">No effects match “{query}”.</p>}
        </div>
      )}

      {tab === 'presets' && (
        <div className="picker-list" role="listbox" aria-label="Presets">
          {shownPresets.map((p) => (
            <div key={p.name} className="preset-row">
              <button role="option" aria-selected={false} className="effect-choice" onClick={() => onPickPreset(p)}>
                <span className="effect-name">{p.name}</span>
                <span className="effect-desc">{EFFECTS[p.effect]?.name ?? p.effect}{p.blend && p.blend !== 'normal' ? ` · ${p.blend}` : ''}{(p.opacity ?? 1) < 1 ? ` · ${Math.round((p.opacity ?? 1) * 100)}%` : ''}</span>
              </button>
              <button className="icon-btn small" aria-label={`Delete preset ${p.name}`} title="Delete preset"
                onClick={() => { if (window.confirm(`Delete the preset “${p.name}”?`)) onDeletePreset(p.name); }}><CloseIcon /></button>
            </div>
          ))}
          {presets.length === 0 && <p className="empty">No presets yet. Select a layer and use “Save as preset” to keep its look.</p>}
          {presets.length > 0 && shownPresets.length === 0 && <p className="empty">No presets match “{query}”.</p>}
        </div>
      )}
    </div>
  );
}

function EffectRow({ fx, onPick }: { fx: EffectDef; onPick: () => void }) {
  return (
    <button role="option" aria-selected={false} className="effect-choice" onClick={onPick}>
      <span className="effect-name">{fx.name}{fx.wled && <span className="badge">WLED</span>}</span>
      <span className="effect-desc">{fx.description}</span>
    </button>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
