import { resolvePathLinkTarget } from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]$/;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;!?]+$/;
const MARKDOWN_LINK_LITERAL_PATTERN = /^\[([^\]]+)\]\(([^)]+)\)$/;
export type MarkdownPathKind = "file" | "directory";
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function parseFileUrlHref(href: string): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const decodedPath = safeDecode(parsed.pathname);
    if (decodedPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = /^\/[A-Za-z]:[\\/]/.test(decodedPath)
      ? decodedPath.slice(1)
      : decodedPath;

    return { path: normalizedPath, hash: parsed.hash };
  } catch {
    return null;
  }
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

function stripEditorPositionSuffix(path: string): string {
  return path.replace(POSITION_SUFFIX_PATTERN, "");
}

function stripTrailingUrlPunctuation(value: string): string {
  let output = value.trim();
  while (TRAILING_URL_PUNCTUATION_PATTERN.test(output)) {
    const nextOutput = output.replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
    if (nextOutput.length === output.length) break;
    output = nextOutput;
  }
  return output;
}

function wordsFromSlug(value: string): string {
  const withoutGitSuffix = value.replace(/\.git$/i, "");
  const spaced = withoutGitSuffix
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .trim();

  if (spaced.length === 0) return withoutGitSuffix;
  return spaced.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function basenameOfPath(path: string): string {
  const withoutPosition = stripEditorPositionSuffix(path).replaceAll("\\", "/");
  const segments = withoutPosition.split("/").filter(Boolean);
  return segments.at(-1) ?? withoutPosition;
}

function basenameLooksLikeFile(path: string): boolean {
  const basename = basenameOfPath(path);
  if (basename.length === 0) return false;
  if (basename.startsWith(".") && !basename.slice(1).includes(".")) return false;
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function normalizeForPathComparison(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(normalized)
    ? normalized[0]!.toLowerCase() + normalized.slice(1)
    : normalized;
}

export function parseMarkdownFileLinkLiteral(
  value: string,
): { label: string; href: string } | null {
  const match = value.trim().match(MARKDOWN_LINK_LITERAL_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    label: match[1].trim(),
    href: match[2].trim(),
  };
}

export function parseMarkdownGitHubLink(
  value: string | undefined,
): { href: string; label: string } | null {
  if (!value) return null;
  const href = stripTrailingUrlPunctuation(value);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (hostname !== "github.com" && hostname !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
  const [owner, repo, section, ...rest] = segments;
  if (!owner || !repo) return null;

  const repoLabel = wordsFromSlug(repo);
  if (section === "releases" && rest[0] === "tag" && rest[1]) {
    return { href, label: `${repoLabel} ${rest[1]}` };
  }
  if ((section === "pull" || section === "issues") && rest[0]) {
    return { href, label: `${repoLabel} #${rest[0]}` };
  }
  if (section === "commit" && rest[0]) {
    return { href, label: `${repoLabel} ${rest[0].slice(0, 7)}` };
  }
  if ((section === "tree" || section === "blob") && rest[0]) {
    return { href, label: `${repoLabel} ${rest[0]}` };
  }
  return { href, label: `${owner}/${repo.replace(/\.git$/i, "")}` };
}

export function normalizeMarkdownFileLinkLabel(
  label: string | undefined,
  targetPath: string,
): string {
  const normalizedLabel = label?.trim();
  if (normalizedLabel && isLikelyPathCandidate(normalizedLabel)) {
    return basenameOfPath(normalizedLabel);
  }
  return normalizedLabel && normalizedLabel.length > 0
    ? normalizedLabel
    : basenameOfPath(targetPath);
}

export function inferMarkdownPathKind(path: string | undefined): MarkdownPathKind {
  const rawPath = path?.trim() ?? "";
  const trimmedPath = stripSearchAndHash(rawPath).path.trim();
  if (trimmedPath.length === 0) return "file";
  if (POSITION_SUFFIX_PATTERN.test(trimmedPath)) return "file";
  if (TRAILING_PATH_SEPARATOR_PATTERN.test(trimmedPath)) return "directory";
  return basenameLooksLikeFile(trimmedPath) ? "file" : "directory";
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim());
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

export function resolveMarkdownFileViewerPath(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!cwd) {
    return null;
  }
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) {
    return null;
  }
  const normalizedCwd = normalizeForPathComparison(cwd);
  const normalizedTarget = normalizeForPathComparison(stripEditorPositionSuffix(targetPath));
  if (normalizedTarget === normalizedCwd) {
    return null;
  }
  if (!normalizedTarget.startsWith(`${normalizedCwd}/`)) {
    return null;
  }
  return normalizedTarget.slice(normalizedCwd.length + 1);
}
