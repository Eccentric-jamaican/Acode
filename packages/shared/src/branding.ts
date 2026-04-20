export const APP_BASE_NAME = "A Code";
export const APP_DEV_STAGE_LABEL = "Dev";
export const APP_RELEASE_STAGE_LABEL = "";
export const APP_DESKTOP_APP_ID = "com.t3tools.t3code.mine";
export const APP_DESKTOP_STATE_ROOT_DIRNAME = ".t3-mine";
export const APP_DESKTOP_ARTIFACT_BASENAME = "T3-Code-Mine";
export const APP_DESKTOP_STAGE_PACKAGE_NAME = "t3-code-desktop-mine";
export const APP_DESKTOP_UPDATE_REPOSITORY = "Eccentric-jamaican/t3code";
export const APP_DESKTOP_ENABLE_AUTO_UPDATES = true;

export function getAppStageLabel(isDevelopment: boolean): string {
  return isDevelopment ? APP_DEV_STAGE_LABEL : APP_RELEASE_STAGE_LABEL;
}

export function getAppDisplayName(isDevelopment: boolean): string {
  return isDevelopment ? `${APP_BASE_NAME} (${APP_DEV_STAGE_LABEL})` : APP_BASE_NAME;
}

export const APP_RELEASE_DISPLAY_NAME = getAppDisplayName(false);
