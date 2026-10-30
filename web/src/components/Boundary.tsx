import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { navigate, reloadApp, useApp } from "../state.ts";
import { Button, Spinner } from "./ui.tsx";

interface BoundaryProps {
  fallback: (again: () => void) => ReactNode;
  // A new key, as the screen changes, tries the children again.
  resetKey?: string;
  onCatch?: () => void;
  children: ReactNode;
}

// What a part of the app that failed to draw leaves in its place, so the rest of the app stays usable.
export class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onCatch?.();
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  again = (): void => this.setState({ failed: false });

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.again) : this.props.children;
  }
}

function Failed({ title, body, primary, onPrimary, secondary, onSecondary }: { title: string; body: string; primary: string; onPrimary: () => void; secondary?: string; onSecondary?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg px-safe-6 py-6" role="alert" data-failed>
      <div className="w-full max-w-sm text-center">
        <div className="text-lg font-semibold">{title}</div>
        <p className="mt-2 text-sm text-muted">{body}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button kind="primary" className="w-full py-3" onClick={onPrimary}>
            {primary}
          </Button>
          {secondary && onSecondary && (
            <Button className="w-full py-3" onClick={onSecondary}>
              {secondary}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// The whole app: a screen that cannot be drawn offers to load the app again, or to go home.
export function AppBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  return (
    <Boundary
      resetKey={resetKey}
      fallback={(again) => (
        <Failed
          title={t("화면을 그리지 못했습니다")}
          body={t("앱을 다시 불러오면 대부분 돌아옵니다.")}
          primary={t("다시 불러오기")}
          onPrimary={reloadApp}
          {...(resetKey === "home" ? {} : { secondary: t("홈으로"), onSecondary: () => (navigate({ name: "home" }), again()) })}
        />
      )}
    >
      {children}
    </Boundary>
  );
}

function Loading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-muted">
      <Spinner className="size-6" />
    </div>
  );
}

// A screen whose code loads the first time it opens, above the rest: a spinner while it comes, and if it does not, why,
// with a way to try again or to close it. Code that did not come is asked for again the next time; a build the broker
// no longer serves is mended only by loading the app again.
export function lazyScreen<P extends { onClose: () => void }>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  let Part = lazy(load);
  const anew = () => void (Part = lazy(load));
  return function LazyScreen(props: P) {
    const [tries, setTries] = useState(0);
    const newBuild = useApp((s) => s.newBuild);
    const reload = Boolean(newBuild) || tries > 0;
    return (
      <Boundary
        onCatch={anew}
        fallback={(again) => (
          <Failed
            title={t("열지 못했습니다")}
            body={newBuild ? t("새 버전이 설치되었습니다. 새로고침하면 열립니다.") : tries > 0 ? t("다시 시도해도 열리지 않으면 앱을 새로고침하세요.") : t("네트워크를 확인하고 다시 시도하세요.")}
            primary={reload ? t("새로고침") : t("다시 시도")}
            onPrimary={
              reload
                ? reloadApp
                : () => {
                    setTries((n) => n + 1);
                    again();
                  }
            }
            secondary={t("닫기")}
            onSecondary={props.onClose}
          />
        )}
      >
        <Suspense fallback={<Loading />}>
          <Part {...props} />
        </Suspense>
      </Boundary>
    );
  };
}
