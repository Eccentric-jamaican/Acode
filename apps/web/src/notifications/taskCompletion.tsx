// FILE: taskCompletion.tsx
// Purpose: Bridges thread lifecycle notifications to in-app toasts and OS notifications.
// Layer: Notification runtime
// Exports: TaskCompletionNotifications and browser permission helpers

import type { DesktopNotificationAction } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAppSettings } from "../appSettings";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { resolvePreferredSplitViewIdForThread, useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import type { Thread } from "../types";
import {
  buildApprovalRequiredCopy,
  buildDesktopNotificationPayload,
  buildTaskCompletionCopy,
  buildUserInputRequiredCopy,
  collectApprovalRequestCandidates,
  collectCompletedThreadCandidates,
  collectUserInputRequestCandidates,
  type DesktopNotificationCandidate,
} from "./taskCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  if (!window.isSecureContext) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const current = readBrowserNotificationPermissionState();
  if (current === "unsupported" || current === "insecure" || current === "denied") {
    return current;
  }
  if (current === "granted") {
    return current;
  }
  return Notification.requestPermission();
}

function isWindowForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

function buildCandidateCopy(
  candidate: DesktopNotificationCandidate,
): { title: string; body: string } {
  switch (candidate.kind) {
    case "turn_completed":
      return buildTaskCompletionCopy(candidate);
    case "approval_required":
      return buildApprovalRequiredCopy(candidate);
    case "user_input_required":
      return buildUserInputRequiredCopy(candidate);
  }
}

async function showDesktopSystemNotification(
  candidate: DesktopNotificationCandidate,
): Promise<boolean> {
  if (window.desktopBridge) {
    const supported = await window.desktopBridge.notifications.isSupported();
    if (!supported) {
      return false;
    }
    return window.desktopBridge.notifications.show(buildDesktopNotificationPayload(candidate));
  }

  if (candidate.kind !== "turn_completed") {
    return false;
  }

  if (readBrowserNotificationPermissionState() !== "granted") {
    return false;
  }

  const { body, title } = buildTaskCompletionCopy(candidate);
  const notification = new Notification(title, {
    body,
    tag: candidate.notificationId,
  });
  notification.addEventListener("click", () => {
    window.focus();
  });
  return true;
}

function navigateToThread(
  candidate: Pick<DesktopNotificationCandidate, "threadId">,
  navigate: ReturnType<typeof useNavigate>,
  splitViewId: string | null,
): void {
  void navigate({
    to: "/$threadId",
    params: { threadId: candidate.threadId },
    ...(splitViewId ? { search: () => ({ splitViewId }) } : {}),
  });
}

function showCandidateToast(
  candidate: DesktopNotificationCandidate,
  navigate: ReturnType<typeof useNavigate>,
  splitViewId: string | null,
): void {
  const { body, title } = buildCandidateCopy(candidate);
  toastManager.add({
    type:
      candidate.kind === "turn_completed"
        ? "success"
        : candidate.kind === "approval_required"
          ? "warning"
          : "info",
    title,
    description: body,
    data: {
      threadId: candidate.threadId,
      dismissAfterVisibleMs: 8000,
    },
    actionProps: {
      children: "Open thread",
      onClick: () => navigateToThread(candidate, navigate, splitViewId),
    },
  });
}

async function handleDesktopNotificationAction(
  action: DesktopNotificationAction,
  navigate: ReturnType<typeof useNavigate>,
  splitViewsById: ReturnType<typeof useSplitViewStore.getState>["splitViewsById"],
  splitViewIdBySourceThreadId: ReturnType<typeof useSplitViewStore.getState>["splitViewIdBySourceThreadId"],
): Promise<void> {
  const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
    splitViewsById,
    splitViewIdBySourceThreadId,
    threadId: action.threadId,
  });

  if (action.kind === "open_thread") {
    navigateToThread(action, navigate, preferredSplitViewId);
    return;
  }

  const api = readNativeApi();
  if (!api) {
    navigateToThread(action, navigate, preferredSplitViewId);
    return;
  }

  try {
    if (action.kind === "approval_response") {
      await api.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: action.threadId,
        requestId: action.requestId,
        decision: action.decision,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.user-input.respond",
      commandId: newCommandId(),
      threadId: action.threadId,
      requestId: action.requestId,
      answers: action.answers,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    navigateToThread(action, navigate, preferredSplitViewId);
    toastManager.add({
      type: "error",
      title: "Notification action failed",
      description:
        error instanceof Error ? error.message : "Unable to complete the desktop notification action.",
      data: {
        threadId: action.threadId,
        dismissAfterVisibleMs: 8000,
      },
    });
  }
}

export function TaskCompletionNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);
  const splitViewIdBySourceThreadId = useSplitViewStore(
    (store) => store.splitViewIdBySourceThreadId,
  );
  const previousThreadsRef = useRef<readonly Thread[]>([]);
  const readyRef = useRef(false);

  useEffect(() => {
    const bridge = window.desktopBridge?.notifications;
    if (!bridge) {
      return;
    }

    void bridge.consumePendingActions().then((actions) => {
      for (const action of actions) {
        void handleDesktopNotificationAction(
          action,
          navigate,
          splitViewsById,
          splitViewIdBySourceThreadId,
        );
      }
    });

    return bridge.onAction((action) => {
      void handleDesktopNotificationAction(
        action,
        navigate,
        splitViewsById,
        splitViewIdBySourceThreadId,
      );
    });
  }, [navigate, splitViewIdBySourceThreadId, splitViewsById]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!readyRef.current) {
      previousThreadsRef.current = threads;
      readyRef.current = true;
      return;
    }

    const candidates: DesktopNotificationCandidate[] = [
      ...collectCompletedThreadCandidates(previousThreadsRef.current, threads),
      ...collectApprovalRequestCandidates(previousThreadsRef.current, threads),
      ...collectUserInputRequestCandidates(previousThreadsRef.current, threads),
    ];
    previousThreadsRef.current = threads;

    if (candidates.length === 0) {
      return;
    }

    const shouldAttemptSystemNotification =
      settings.enableSystemTaskCompletionNotifications && (isElectron || !isWindowForeground());

    for (const candidate of candidates) {
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: candidate.threadId,
      });

      if (settings.enableTaskCompletionToasts) {
        showCandidateToast(candidate, navigate, preferredSplitViewId);
      }

      if (shouldAttemptSystemNotification) {
        void showDesktopSystemNotification(candidate);
      }
    }
  }, [
    navigate,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    splitViewIdBySourceThreadId,
    splitViewsById,
    threads,
    threadsHydrated,
  ]);

  return null;
}

export function buildNotificationSettingsSupportText(
  permissionState: BrowserNotificationPermissionState,
): string {
  if (isElectron) {
    return "Desktop app notifications use your operating system notification center for completed turns and threads that need input.";
  }
  switch (permissionState) {
    case "granted":
      return "Browser notifications are enabled for this app.";
    case "denied":
      return "Browser notifications are blocked. Re-enable them in your browser site settings.";
    case "insecure":
      return "Browser notifications need a secure context. Localhost works; plain HTTP does not.";
    case "unsupported":
      return "This browser does not support desktop notifications.";
    case "default":
      return "Allow browser notifications to get alerts when a thread finishes in the background.";
  }
}
