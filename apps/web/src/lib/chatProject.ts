export const CHATS_PROJECT_TITLE = "chats";
export const LEGACY_CHATS_PROJECT_TITLE = "Home";
const CHAT_THREAD_SLUG_MAX_LENGTH = 64;

type ProjectLike = {
  readonly cwd: string;
  readonly name: string;
};

export function isChatsProject(
  project: ProjectLike,
  chatWorkspaceRoot: string | null | undefined,
): boolean {
  return (
    chatWorkspaceRoot !== null &&
    chatWorkspaceRoot !== undefined &&
    project.cwd === chatWorkspaceRoot &&
    (project.name === CHATS_PROJECT_TITLE || project.name === LEGACY_CHATS_PROJECT_TITLE)
  );
}

export function formatChatThreadDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function slugifyChatThreadTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHAT_THREAD_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  return slug || "chat";
}

export function joinClientPath(root: string, child: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child.replace(/^[\\/]+/, "")}`;
}

export function buildChatThreadRelativePath(input: {
  readonly createdAt: string;
  readonly title: string;
  readonly suffix?: number;
}): string {
  const timestamp = new Date(input.createdAt);
  const date = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const baseSlug = slugifyChatThreadTitle(input.title);
  const slug = input.suffix && input.suffix > 1 ? `${baseSlug}-${input.suffix}` : baseSlug;
  return `${formatChatThreadDate(date)}/${slug}`;
}
