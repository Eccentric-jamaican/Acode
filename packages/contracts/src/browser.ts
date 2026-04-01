import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas";

export const BrowserSessionId = TrimmedNonEmptyString;
export type BrowserSessionId = typeof BrowserSessionId.Type;

export const BrowserTabId = TrimmedNonEmptyString;
export type BrowserTabId = typeof BrowserTabId.Type;

export const BrowserPaneBounds = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type BrowserPaneBounds = typeof BrowserPaneBounds.Type;

export const BrowserNavigationState = Schema.Struct({
  url: Schema.NullOr(TrimmedNonEmptyString),
  title: Schema.NullOr(Schema.String),
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  isLoading: Schema.Boolean,
  lastCommittedAt: Schema.NullOr(IsoDateTime),
});
export type BrowserNavigationState = typeof BrowserNavigationState.Type;

export const BrowserSessionSummary = Schema.Struct({
  sessionId: BrowserSessionId,
  projectId: ProjectId,
  inspectMode: Schema.Boolean,
  hasSelection: Schema.Boolean,
  navigation: BrowserNavigationState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserSessionSummary = typeof BrowserSessionSummary.Type;

export const BrowserTabSummary = Schema.Struct({
  tabId: BrowserTabId,
  sessionId: BrowserSessionId,
  projectId: ProjectId,
  inspectMode: Schema.Boolean,
  hasSelection: Schema.Boolean,
  navigation: BrowserNavigationState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BrowserTabSummary = typeof BrowserTabSummary.Type;

export const BrowserSessionSnapshot = Schema.Struct({
  paneOpen: Schema.Boolean,
  paneProjectId: Schema.NullOr(ProjectId),
  paneBounds: Schema.NullOr(BrowserPaneBounds),
  session: Schema.NullOr(BrowserSessionSummary),
  tabs: Schema.optional(Schema.Array(BrowserTabSummary)),
  activeTabId: Schema.optional(Schema.NullOr(BrowserTabId)),
});
export type BrowserSessionSnapshot = typeof BrowserSessionSnapshot.Type;

export const BrowserInspectBoundingBox = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserInspectBoundingBox = typeof BrowserInspectBoundingBox.Type;

export const BrowserInspectCapture = Schema.Struct({
  sessionId: BrowserSessionId,
  projectId: ProjectId,
  url: TrimmedNonEmptyString,
  tagName: TrimmedNonEmptyString,
  selector: TrimmedNonEmptyString,
  ancestry: Schema.Array(TrimmedNonEmptyString),
  textSummary: Schema.String,
  accessibilitySummary: Schema.String,
  sourceUrl: Schema.NullOr(TrimmedNonEmptyString),
  sourceLocation: Schema.NullOr(TrimmedNonEmptyString),
  boundingBox: BrowserInspectBoundingBox,
  computedStyle: Schema.Record(Schema.String, Schema.String),
  screenshotDataUrl: TrimmedNonEmptyString,
  capturedAt: IsoDateTime,
});
export type BrowserInspectCapture = typeof BrowserInspectCapture.Type;

export const BrowserRuntimeEventPaneRequested = Schema.Struct({
  type: Schema.Literal("pane.requested"),
  projectId: ProjectId,
});
export type BrowserRuntimeEventPaneRequested = typeof BrowserRuntimeEventPaneRequested.Type;

export const BrowserRuntimeEventStateUpdated = Schema.Struct({
  type: Schema.Literal("state.updated"),
  projectId: ProjectId,
  snapshot: BrowserSessionSnapshot,
});
export type BrowserRuntimeEventStateUpdated = typeof BrowserRuntimeEventStateUpdated.Type;

export const BrowserRuntimeEventInspectSelectionChanged = Schema.Struct({
  type: Schema.Literal("inspect.selection.changed"),
  projectId: ProjectId,
  hasSelection: Schema.Boolean,
});
export type BrowserRuntimeEventInspectSelectionChanged =
  typeof BrowserRuntimeEventInspectSelectionChanged.Type;

export const BrowserRuntimeEvent = Schema.Union([
  BrowserRuntimeEventPaneRequested,
  BrowserRuntimeEventStateUpdated,
  BrowserRuntimeEventInspectSelectionChanged,
]);
export type BrowserRuntimeEvent = typeof BrowserRuntimeEvent.Type;

export const BrowserOpenInput = Schema.Struct({
  projectId: ProjectId,
  bounds: BrowserPaneBounds,
});
export type BrowserOpenInput = typeof BrowserOpenInput.Type;

export const BrowserProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type BrowserProjectInput = typeof BrowserProjectInput.Type;

export const BrowserCreateTabInput = Schema.Struct({
  projectId: ProjectId,
  url: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserCreateTabInput = typeof BrowserCreateTabInput.Type;

export const BrowserActivateTabInput = Schema.Struct({
  projectId: ProjectId,
  tabId: BrowserTabId,
});
export type BrowserActivateTabInput = typeof BrowserActivateTabInput.Type;

export const BrowserCloseTabInput = Schema.Struct({
  projectId: ProjectId,
  tabId: BrowserTabId,
});
export type BrowserCloseTabInput = typeof BrowserCloseTabInput.Type;

export const BrowserNavigateInput = Schema.Struct({
  projectId: ProjectId,
  url: TrimmedNonEmptyString,
});
export type BrowserNavigateInput = typeof BrowserNavigateInput.Type;

export const BrowserSetInspectModeInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type BrowserSetInspectModeInput = typeof BrowserSetInspectModeInput.Type;
