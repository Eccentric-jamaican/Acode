const LANGUAGE_ALIASES = Object.freeze({
  env: "dotenv",
});

const DEFAULT_LANGUAGE = "text";

export function normalizeSyntaxLanguage(language: string | null | undefined): string {
  const normalized = language?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return DEFAULT_LANGUAGE;
  }
  return LANGUAGE_ALIASES[normalized as keyof typeof LANGUAGE_ALIASES] ?? normalized;
}
