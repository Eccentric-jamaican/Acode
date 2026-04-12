function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function lastPathSegment(value: string): string | null {
  const parts = value.split("/").filter((part) => part.length > 0);
  const lastPart = parts.at(-1)?.trim();
  return lastPart && lastPart.length > 0 ? lastPart : null;
}

function normalizeRepositoryName(value: string | null): string | null {
  if (!value) return null;
  const candidate = stripGitSuffix(value.trim());
  if (
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\")
  ) {
    return null;
  }
  return candidate;
}

export function deriveRepositoryDirectoryName(repositoryUrl: string): string | null {
  const trimmed = repositoryUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const sshLikeMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (sshLikeMatch) {
    return normalizeRepositoryName(lastPathSegment(sshLikeMatch[1] ?? ""));
  }

  const scpLikeMatch = trimmed.match(/^[^:\s]+:(.+)$/);
  if (scpLikeMatch && !trimmed.includes("://")) {
    return normalizeRepositoryName(lastPathSegment(scpLikeMatch[1] ?? ""));
  }

  try {
    const url = new URL(trimmed);
    return normalizeRepositoryName(lastPathSegment(url.pathname));
  } catch {
    return normalizeRepositoryName(lastPathSegment(trimmed));
  }
}
