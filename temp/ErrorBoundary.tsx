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
          padding: 12, background: '#fee2e2', borderRadius: 8,
          fontSize: 12, color: '#b91c1c', border: '1px solid #fecaca',
        }}>
          {this.props.name || 'Component'} error: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}
