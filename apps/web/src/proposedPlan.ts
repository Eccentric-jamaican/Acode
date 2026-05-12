import type { ProjectEntry } from "@t3tools/contracts";

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

function basenameOfWorkspacePath(pathValue: string): string {
  return pathValue.split(/[\\/]/).at(-1) ?? pathValue;
}

function joinWorkspacePath(directoryPath: string, fileName: string): string {
  const trimmedDirectory = directoryPath.replace(/[\\/]+$/g, "");
  return trimmedDirectory.length > 0 ? `${trimmedDirectory}/${fileName}` : fileName;
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

export function resolvePlanFollowUpSubmission(input: { draftText: string; planMarkdown: string }): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: "plan",
    };
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function findWorkspacePlansDirectories(
  entries: ReadonlyArray<Pick<ProjectEntry, "kind" | "path">>,
): ReadonlyArray<string> {
  return entries
    .filter(
      (entry) =>
        entry.kind === "directory" && basenameOfWorkspacePath(entry.path).toLowerCase() === "plans",
    )
    .map((entry) => entry.path)
    .toSorted((left, right) => {
      if (left.toLowerCase() === "plans") return -1;
      if (right.toLowerCase() === "plans") return 1;
      return left.localeCompare(right);
    });
}

export function buildProposedPlanWorkspacePath(input: {
  directoryPath: string;
  planMarkdown: string;
}): string {
  return joinWorkspacePath(
    input.directoryPath,
    buildProposedPlanMarkdownFilename(input.planMarkdown),
  );
}
