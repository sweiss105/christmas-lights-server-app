import { PanelIcon } from './icons';

/**
 * The top of a contextual panel: what it's for, its own buttons, and a button that tucks the panel
 * away (the 3D view then takes the space). Without a title, `children` take the title's place
 * (Control's tabs); otherwise they go under it.
 */
export function PanelHead({ title, eyebrow, actions, onHide, children }: {
  title?: React.ReactNode; eyebrow?: React.ReactNode; actions?: React.ReactNode; onHide?: () => void; children?: React.ReactNode;
}) {
  const hide = onHide && (
    <button className="icon-btn small panel-hide" aria-label="Hide the panel" title="Hide the panel" onClick={onHide}><PanelIcon shown /></button>
  );
  return (
    <div className="panel-top">
      <div className="panel-top-row">
        {title === undefined ? <div className="panel-top-main">{children}</div> : (
          <div className="editor-title">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {typeof title === 'string' ? <h2>{title}</h2> : title}
          </div>
        )}
        {actions}
        {hide}
      </div>
      {title !== undefined && children}
    </div>
  );
}
