import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches an error thrown while drawing the UI, which would otherwise leave a blank page. The lights
 * are driven by the server, so they carry on regardless; this only offers a way back into the UI.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI error', error, info.componentStack); }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="loading" role="alert">
        <p>Something went wrong showing this screen. The lights themselves are not affected.</p>
        <p className="hint">{error.message}</p>
        <div className="row">
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn ghost" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
