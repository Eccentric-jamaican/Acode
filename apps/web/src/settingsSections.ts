export const SETTINGS_SECTION_IDS = {
  appearance: "appearance",
  models: "models",
  remoteAccess: "remote-access",
  responses: "responses",
  browserUse: "browser-use",
  computerUse: "computer-use",
  keybindings: "keybindings",
  safety: "safety",
  providers: "providers",
  archived: "archived",
} as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[keyof typeof SETTINGS_SECTION_IDS];

export function normalizeSettingsSectionId(value: unknown): SettingsSectionId {
  if (value === "remote access") {
    return SETTINGS_SECTION_IDS.remoteAccess;
  }

  return typeof value === "string" &&
    (Object.values(SETTINGS_SECTION_IDS) as string[]).includes(value)
    ? (value as SettingsSectionId)
    : SETTINGS_SECTION_IDS.appearance;
}

export const SETTINGS_SIDEBAR_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
}> = [
  { id: SETTINGS_SECTION_IDS.appearance, label: "Appearance" },
  { id: SETTINGS_SECTION_IDS.models, label: "Models" },
  { id: SETTINGS_SECTION_IDS.remoteAccess, label: "Remote access" },
  { id: SETTINGS_SECTION_IDS.responses, label: "Responses" },
  { id: SETTINGS_SECTION_IDS.browserUse, label: "Browser use" },
  { id: SETTINGS_SECTION_IDS.computerUse, label: "Computer use" },
  { id: SETTINGS_SECTION_IDS.keybindings, label: "Keybindings" },
  { id: SETTINGS_SECTION_IDS.safety, label: "Safety" },
  { id: SETTINGS_SECTION_IDS.providers, label: "Providers" },
  { id: SETTINGS_SECTION_IDS.archived, label: "Archived" },
];
