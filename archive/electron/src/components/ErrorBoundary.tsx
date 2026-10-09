import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message || 'Unknown render error' };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled render error:', error, errorInfo);
    try {
      window.electron?.savePersistenceLog?.(
        `[ErrorBoundary] Render crash: ${error?.message || error}\nStack: ${error?.stack || ''}\nComponentStack: ${errorInfo?.componentStack || ''}`
      );
    } catch (_) {
      /* ignore */
    }
  }

  private handleRecover = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#101014]/90 text-white p-6 backdrop-blur-md select-none font-sans">
          <div className="max-w-md w-full bg-[#18181c] border border-white/10 rounded-xl p-5 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 text-rose-400">
              <span className="text-xl">⚠️</span>
              <h2 className="text-base font-semibold text-white">Rovyl UI Recovered</h2>
            </div>
            <p className="text-xs text-white/70 leading-relaxed">
              An unexpected render error occurred. The launcher captured the fault to keep running safely.
            </p>
            {this.state.errorMessage && (
              <pre className="text-[11px] bg-black/40 text-rose-300/80 p-2 rounded overflow-x-auto max-h-24">
                {this.state.errorMessage}
              </pre>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={this.handleRecover}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/10 hover:bg-white/20 active:bg-white/30 text-white transition-colors"
              >
                Reload Interface
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
