interface ResolveMessageRoleInput {
  readonly sessionId: string;
  readonly messageId: string;
  readonly roleHint?: string;
  readonly fetchRole: () => Promise<string | undefined>;
}

const normalizeRole = (role: string | undefined): string | undefined => {
  const normalized = role?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const roleKey = (sessionId: string, messageId: string): string =>
  `${sessionId}:${messageId}`;

export class OpencodeMessageRoleGate {
  private readonly roleBySessionAndMessage = new Map<string, string>();

  remember(sessionId: string, messageId: string, role: string | undefined): void {
    const normalized = normalizeRole(role);
    if (!normalized) return;
    this.roleBySessionAndMessage.set(roleKey(sessionId, messageId), normalized);
  }

  async resolve(input: ResolveMessageRoleInput): Promise<string | undefined> {
    const hinted = normalizeRole(input.roleHint);
    if (hinted) {
      this.roleBySessionAndMessage.set(
        roleKey(input.sessionId, input.messageId),
        hinted,
      );
      return hinted;
    }

    const key = roleKey(input.sessionId, input.messageId);
    const cached = this.roleBySessionAndMessage.get(key);
    if (cached) return cached;

    const fetched = normalizeRole(await input.fetchRole());
    if (fetched) {
      this.roleBySessionAndMessage.set(key, fetched);
    }
    return fetched;
  }

  clearSession(sessionId: string): void {
    for (const [key] of this.roleBySessionAndMessage.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.roleBySessionAndMessage.delete(key);
      }
    }
  }

  clearAll(): void {
    this.roleBySessionAndMessage.clear();
  }
}
