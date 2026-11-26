import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface DialogButton { id: string; label: string; kind?: 'primary' | 'ghost' | 'danger' }
export interface DialogSpec {
  title: string;
  message?: string;
  /** Ask for a name: the value comes back with the choice. `check` says what's wrong with it (blocks the primary button). */
  input?: { label: string; value: string; check?: (v: string) => string | null };
  buttons: DialogButton[];
  /** The button Escape and the backdrop stand for. */
  cancel: string;
}
export interface DialogAnswer { choice: string; value: string }
export type Ask = (spec: DialogSpec) => Promise<DialogAnswer>;

/** One question at a time, answered with a promise: `const { choice } = await ask({...})`. */
export function useDialog(): { element: React.ReactNode; ask: Ask } {
  const [open, setOpen] = useState<{ spec: DialogSpec; resolve: (a: DialogAnswer) => void } | null>(null);
  const ask = useCallback<Ask>((spec) => new Promise((resolve) => setOpen({ spec, resolve })), []);
  const element = open ? (
    <Dialog key={open.spec.title} spec={open.spec} onAnswer={(a) => { setOpen(null); open.resolve(a); }} />
  ) : null;
  return { element, ask };
}

function Dialog({ spec, onAnswer }: { spec: DialogSpec; onAnswer: (a: DialogAnswer) => void }) {
  const [value, setValue] = useState(spec.input?.value ?? '');
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const problem = spec.input?.check?.(value) ?? null;
  const primary = spec.buttons.find((b) => b.kind === 'primary' || b.kind === undefined);

  useEffect(() => {
    // Focus the name field, or the first button, so the keyboard works straight away.
    const el = box.current?.querySelector<HTMLElement>('input, button');
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  const answer = (choice: string) => {
    if (spec.input && choice !== spec.cancel && problem && choice === primary?.id) return;
    onAnswer({ choice, value: value.trim() });
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) answer(spec.cancel); }}>
      <div ref={box} className="dialog glass" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(spec.cancel); } }}>
        <h2 id={titleId}>{spec.title}</h2>
        {spec.message && <p>{spec.message}</p>}
        {spec.input && (
          <form onSubmit={(e) => { e.preventDefault(); if (primary) answer(primary.id); }}>
            <label className="field-label" htmlFor={`${titleId}-name`}>{spec.input.label}</label>
            <input id={`${titleId}-name`} className="text" value={value} maxLength={80} autoComplete="off" spellCheck={false}
              aria-invalid={!!problem} onChange={(e) => setValue(e.target.value)} />
            {problem && value.trim() !== '' && <p className="dialog-problem" role="alert">{problem}</p>}
          </form>
        )}
        <div className="dialog-buttons">
          {spec.buttons.map((b) => (
            <button key={b.id} className={`btn ${b.kind === 'ghost' ? 'ghost' : b.kind === 'danger' ? 'ghost danger-quiet' : 'primary'}`}
              disabled={!!spec.input && b.id === primary?.id && !!problem} onClick={() => answer(b.id)}>{b.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
