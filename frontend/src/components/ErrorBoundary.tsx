'use client';
import { Component, ReactNode } from 'react';

interface Props { children: ReactNode; name?: string; }
interface State { error: string | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: Error): State {
    return { error: err.message };
  }

  componentDidCatch(err: Error) {
    console.error(`[ErrorBoundary:${this.props.name}]`, err.message);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 12, background: 'var(--tint-danger)', borderRadius: 8,
          fontSize: 'var(--text-sm)', color: 'var(--tint-danger-fg)', border: '1px solid var(--tint-danger)',
        }}>
          {this.props.name || 'Component'} error: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}
