export const SETTINGS_SECTION_IDS = {
  appearance: "appearance",
  codexAppServer: "codex-app-server",
  models: "models",
  responses: "responses",
  browserUse: "browser-use",
  keybindings: "keybindings",
  safety: "safety",
  archived: "archived",
} as const;

export type SettingsSectionId =
  (typeof SETTINGS_SECTION_IDS)[keyof typeof SETTINGS_SECTION_IDS];

export const SETTINGS_SIDEBAR_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
}> = [
  { id: SETTINGS_SECTION_IDS.appearance, label: "Appearance" },
  { id: SETTINGS_SECTION_IDS.codexAppServer, label: "Codex App Server" },
  { id: SETTINGS_SECTION_IDS.models, label: "Models" },
  { id: SETTINGS_SECTION_IDS.responses, label: "Responses" },
  { id: SETTINGS_SECTION_IDS.browserUse, label: "Browser use" },
  { id: SETTINGS_SECTION_IDS.keybindings, label: "Keybindings" },
  { id: SETTINGS_SECTION_IDS.safety, label: "Safety" },
  { id: SETTINGS_SECTION_IDS.archived, label: "Archived" },
];
