import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type BrowserNavigation = EventTarget & {
  canGoBack?: boolean;
  canGoForward?: boolean;
  back?: () => Promise<unknown>;
  forward?: () => Promise<unknown>;
};

type NavigationState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

function readBrowserNavigation(): BrowserNavigation | null {
  return ((window as Window & { navigation?: BrowserNavigation }).navigation ?? null) as
    | BrowserNavigation
    | null;
}

function readNavigationState(): NavigationState {
  const navigation = readBrowserNavigation();
  if (navigation) {
    return {
      canGoBack: navigation.canGoBack === true,
      canGoForward: navigation.canGoForward === true,
    };
  }

  return {
    canGoBack: window.history.length > 1,
    canGoForward: false,
  };
}

function scheduleNavigationStateUpdate(update: () => void) {
  window.requestAnimationFrame(() => {
    update();
  });
}

function settleNavigationAction(action: Promise<unknown>, update: () => void) {
  void action.then(
    () => scheduleNavigationStateUpdate(update),
    () => scheduleNavigationStateUpdate(update),
  );
}

export function AppNavigationControls({
  className,
  buttonClassName,
}: {
  className?: string;
  buttonClassName?: string;
}) {
  const routeSignature = useRouterState({
    select: (state) => `${state.location.pathname}:${JSON.stringify(state.location.search)}`,
  });
  const [navigationState, setNavigationState] = useState<NavigationState>(() =>
    typeof window === "undefined"
      ? { canGoBack: false, canGoForward: false }
      : readNavigationState(),
  );

  const updateNavigationState = useCallback(() => {
    setNavigationState(readNavigationState());
  }, []);

  useEffect(() => {
    updateNavigationState();
  }, [routeSignature, updateNavigationState]);

  useEffect(() => {
    const updateSoon = () => scheduleNavigationStateUpdate(updateNavigationState);
    const navigation = readBrowserNavigation();

    window.addEventListener("popstate", updateSoon);
    window.addEventListener("hashchange", updateSoon);
    navigation?.addEventListener("currententrychange", updateSoon);
    navigation?.addEventListener("navigate", updateSoon);

    return () => {
      window.removeEventListener("popstate", updateSoon);
      window.removeEventListener("hashchange", updateSoon);
      navigation?.removeEventListener("currententrychange", updateSoon);
      navigation?.removeEventListener("navigate", updateSoon);
    };
  }, [updateNavigationState]);

  const goBack = useCallback(() => {
    const navigation = readBrowserNavigation();
    if (navigation?.canGoBack === true && navigation.back) {
      settleNavigationAction(navigation.back(), updateNavigationState);
      return;
    }

    window.history.back();
    scheduleNavigationStateUpdate(updateNavigationState);
  }, [updateNavigationState]);

  const goForward = useCallback(() => {
    const navigation = readBrowserNavigation();
    if (navigation?.canGoForward === true && navigation.forward) {
      settleNavigationAction(navigation.forward(), updateNavigationState);
      return;
    }

    window.history.forward();
    scheduleNavigationStateUpdate(updateNavigationState);
  }, [updateNavigationState]);

  return (
    <div className={cn("flex items-center gap-1", className)} data-testid="app-navigation-controls">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Go back"
              className={cn(
                "size-7 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent/55 hover:text-foreground disabled:opacity-35",
                buttonClassName,
              )}
              disabled={!navigationState.canGoBack}
              onClick={goBack}
              size="icon-sm"
              variant="ghost"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Back</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Go forward"
              className={cn(
                "size-7 rounded-md border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent/55 hover:text-foreground disabled:opacity-35",
                buttonClassName,
              )}
              disabled={!navigationState.canGoForward}
              onClick={goForward}
              size="icon-sm"
              variant="ghost"
            >
              <ArrowRightIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Forward</TooltipPopup>
      </Tooltip>
    </div>
  );
}
