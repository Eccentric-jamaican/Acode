import type {
  ComputerUseAppCategory,
  ComputerUseAppSummary,
  ComputerUseSettings,
} from "@t3tools/contracts";

function normalizeComputerUsePermissionCategory(
  category: ComputerUseAppCategory,
): ComputerUseAppCategory {
  return category === "agent" ? "desktop" : category;
}

export function normalizeComputerUseCategoryList(
  categories: readonly ComputerUseAppCategory[],
): ComputerUseAppCategory[] {
  return Array.from(new Set(categories.map(normalizeComputerUsePermissionCategory)));
}

export function isComputerUseAppAllowed(
  app: Pick<ComputerUseAppSummary, "appId" | "category">,
  settings: Pick<
    ComputerUseSettings,
    "enabled" | "enabledAppCategories" | "allowedAppIds" | "blockedAppIds"
  >,
): boolean {
  if (!settings.enabled) return false;
  if (settings.blockedAppIds.includes(app.appId)) return false;
  if (settings.allowedAppIds.includes(app.appId)) return true;
  return settings.enabledAppCategories.includes(
    normalizeComputerUsePermissionCategory(app.category),
  );
}
