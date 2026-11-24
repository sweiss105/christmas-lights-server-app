import { useMemo, useRef, useState } from 'react';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { combine, inCircle, inPolygon, inRect, runAt, type SelectMode, type Selection } from './selection';

export type SelectTool = 'orbit' | 'box' | 'lasso' | 'brush' | 'string';

/** How near (in screen pixels) a tap must land to a light to pick its string. */
const STRING_REACH = 16;

interface Props {
  tool: SelectTool;
  mode: SelectMode;
  brushSize: number;
  project: () => Float32Array;
  layoutConfig: LayoutConfig;
  selection: Selection;
  onChange: (s: Selection) => void;
}

/**
 * Drawing layer over the 3D view for box, lasso, brush and tap-a-string selection. Shift adds and Alt/Option
 * subtracts, whatever the mode buttons say. With the orbit tool it lets pointer events through, so
 * the camera can be moved.
 */
export function SelectionOverlay({ tool, mode, brushSize, project, layoutConfig, selection, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<[number, number][]>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  /** The drag in progress: `acc` is the running result of a brush stroke. */
  const drag = useRef<{ mode: SelectMode; screen: Float32Array; start: Selection; acc: Selection } | null>(null);
  const layout = useMemo(() => buildLayout(layoutConfig), [layoutConfig]);

  if (tool === 'orbit') return null;

  const at = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const modeFor = (e: React.PointerEvent): SelectMode => (e.shiftKey ? 'add' : e.altKey ? 'subtract' : mode);
  // A brush stroke in replace mode starts from nothing, then keeps adding.
  const brushMode = (m: SelectMode): SelectMode => (m === 'replace' ? 'add' : m);

  const paint = (p: [number, number]) => {
    const d = drag.current!;
    d.acc = combine(d.acc, inCircle(d.screen, p[0], p[1], brushSize), brushMode(d.mode));
    onChange(new Set(d.acc));
  };
  return (
    <div
      ref={ref}
      className={`select-overlay tool-${tool}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const m = modeFor(e);
        const start = m === 'replace' ? new Set<number>() : selection;
        drag.current = { mode: m, screen: project(), start, acc: new Set(start) };
        const p = at(e);
        setPath([p]);
        if (tool === 'brush') paint(p);
        if (tool === 'string') {
          drag.current = null;
          const hit = runAt(layout, project(), p[0], p[1], STRING_REACH);
          // Tapping empty space in New mode clears; otherwise strings add to or come off the selection.
          onChange(combine(start, hit, m === 'replace' ? 'add' : m));
          setPath([]);
        }
      }}
      onPointerMove={(e) => {
        const p = at(e);
        setHover(p);
        if (!drag.current) return;
        if (tool === 'box') setPath((old) => [old[0]!, p]);
        else if (tool === 'lasso') setPath((old) => (Math.hypot(p[0] - old.at(-1)![0], p[1] - old.at(-1)![1]) > 3 ? [...old, p] : old));
        else paint(p);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const p = at(e);
        if (tool === 'box' && path.length) {
          const [x0, y0] = path[0]!;
          onChange(combine(d.start, inRect(d.screen, { x0, y0, x1: p[0], y1: p[1] }), d.mode === 'replace' ? 'add' : d.mode));
        } else if (tool === 'lasso' && path.length > 2) {
          onChange(combine(d.start, inPolygon(d.screen, [...path, p]), d.mode === 'replace' ? 'add' : d.mode));
        }
        setPath([]);
      }}
      onPointerCancel={() => { drag.current = null; setPath([]); }}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="select-svg" aria-hidden>
        {tool === 'box' && path.length === 2 && (
          <rect x={Math.min(path[0]![0], path[1]![0])} y={Math.min(path[0]![1], path[1]![1])}
            width={Math.abs(path[1]![0] - path[0]![0])} height={Math.abs(path[1]![1] - path[0]![1])} />
        )}
        {tool === 'lasso' && path.length > 1 && <polygon points={path.map((q) => q.join(',')).join(' ')} />}
        {tool === 'brush' && hover && <circle cx={hover[0]} cy={hover[1]} r={brushSize} />}
      </svg>
    </div>
  );
}
