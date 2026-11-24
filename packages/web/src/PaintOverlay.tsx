import { useEffect, useRef, useState } from 'react';
import type { SceneConfig } from '@xmas/engine';
import type { Look, SceneEditor } from './editor';
import { applyStroke, dab, dabLine, type Brush, type PaintTarget } from './paint';

export type PaintTool = 'orbit' | 'paint' | 'erase';

interface Props {
  tool: PaintTool;
  brush: Brush;
  /** What the brush paints with; null until a colour or effect is chosen. */
  look: Look | null;
  /** Colour of the brush ring (the paint colour, when it has one). */
  tint: string | null;
  project: () => Float32Array;
  editor: SceneEditor;
  /** Number of lights in the layout. */
  count: number;
}

let strokeSeq = 0;

/**
 * Drawing layer over the 3D view for the paint brush and eraser. The scene updates as the pointer
 * moves (at most once per frame), and a whole stroke is one undo step. Option/Alt erases while
 * held. With the Move tool it lets pointer events through, so the camera can be turned.
 */
export function PaintOverlay({ tool, brush, look, tint, project, editor, count }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [erasing, setErasing] = useState(false);
  const drag = useRef<{ screen: Float32Array; base: SceneConfig; stroke: Float32Array; target: PaintTarget; last: [number, number]; key: string; frame: number } | null>(null);

  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.frame) { cancelAnimationFrame(d.frame); editor.edit(applyStroke(d.base, d.target, d.stroke), { merge: d.key }); }
    editor.endGesture();
    setErasing(false);
  };
  // Leaving the mode mid-stroke still finishes the stroke.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(), []);

  if (tool === 'orbit') return null;

  const at = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** Show the stroke so far, once per frame however fast the pointer reports. */
  const schedule = () => {
    const d = drag.current!;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (drag.current === d) editor.edit(applyStroke(d.base, d.target, d.stroke), { merge: d.key });
    });
  };

  const eraser = tool === 'erase' || erasing;
  const core = brush.size * (1 - brush.softness);
  return (
    <div
      ref={ref}
      className={`select-overlay paint-overlay ${eraser ? 'erasing' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        const erase = tool === 'erase' || e.altKey;
        if (!erase && !look) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        const d = { screen: project(), base: editor.scene, stroke: new Float32Array(count), target: (erase ? { kind: 'erase' } : { kind: 'look', look: look! }) as PaintTarget, last: p, key: `stroke-${++strokeSeq}`, frame: 0 };
        drag.current = d;
        setErasing(erase);
        setHover(p);
        dab(d.screen, p[0], p[1], brush, d.stroke);
        editor.edit(applyStroke(d.base, d.target, d.stroke), { merge: d.key }); // the first touch shows at once
      }}
      onPointerMove={(e) => {
        const p = at(e);
        setHover(p);
        const d = drag.current;
        if (!d) return;
        dabLine(d.screen, d.last, p, brush, d.stroke);
        d.last = p;
        schedule();
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => { if (!drag.current) setHover(null); }}
    >
      <svg className="select-svg paint-svg" aria-hidden>
        {hover && (
          <g style={{ color: eraser ? '#ffffff' : tint ?? '#ffffff' }}>
            <circle className="brush-edge" cx={hover[0]} cy={hover[1]} r={brush.size} />
            {brush.softness > 0.05 && core > 2 && <circle className="brush-core" cx={hover[0]} cy={hover[1]} r={core} />}
          </g>
        )}
      </svg>
    </div>
  );
}
