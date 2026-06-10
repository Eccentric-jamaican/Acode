import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";
import ACODE_ICON from "../../../assets/prod/ACODE.png";
import ACODE_DARK_ICON from "../../../assets/prod/ACODE-DARK.png";

import { applyDesktopWindowChromeMetrics } from "./desktopWindowChrome";
import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { reportClientDiagnostic } from "./errorInboxReporter";

const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;
applyDesktopWindowChromeMetrics(document.documentElement);

function syncDocumentIcons() {
  const iconHref = document.documentElement.classList.contains("dark") ? ACODE_DARK_ICON : ACODE_ICON;

  for (const rel of ["icon", "apple-touch-icon"]) {
    const selector = `link[rel='${rel}']`;
    const existing = document.querySelector<HTMLLinkElement>(selector);
    if (existing) {
      existing.href = iconHref;
      continue;
    }

    const link = document.createElement("link");
    link.rel = rel;
    link.href = iconHref;
    document.head.append(link);
  }
}

syncDocumentIcons();

new MutationObserver(() => {
  syncDocumentIcons();
}).observe(document.documentElement, { attributeFilter: ["class"], attributes: true });

interface AppRootErrorBoundaryState {
  readonly error: Error | null;
  readonly resetKey: number;
}

class AppRootErrorBoundary extends React.Component<
  React.PropsWithChildren,
  AppRootErrorBoundaryState
> {
  override state: AppRootErrorBoundaryState = {
    error: null,
    resetKey: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<AppRootErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    reportClientDiagnostic({
      source: "browser-runtime",
      category: "browser",
      severity: "error",
      summary: "Root render failed",
      detail: error.message,
      context: {
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      },
    });
  }

  private readonly reset = () => {
    this.setState((state) => ({
      error: null,
      resetKey: state.resetKey + 1,
    }));
  };

  override render() {
    if (this.state.error) {
      const details = this.state.error.stack ?? this.state.error.message;
      return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
          <section className="w-full max-w-xl rounded-lg border border-border bg-card p-6 shadow-xl">
            <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {APP_DISPLAY_NAME}
            </p>
            <h1 className="mt-3 text-2xl font-semibold">Something went wrong.</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The app hit a rendering error. Reloading usually restores the current workspace.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                type="button"
                onClick={this.reset}
              >
                Try again
              </button>
              <button
                className="rounded-md border border-border px-3 py-2 text-sm font-medium"
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
            </div>
            <details className="mt-5 rounded-md border border-border bg-background/70">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                Error details
              </summary>
              <pre className="max-h-56 overflow-auto border-t border-border px-3 py-2 text-xs">
                {details}
              </pre>
            </details>
          </section>
        </div>
      );
    }

    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRootErrorBoundary>
      <RouterProvider router={router} />
    </AppRootErrorBoundary>
  </React.StrictMode>,
);
