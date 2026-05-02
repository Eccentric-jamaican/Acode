const DEFAULT_TIMEOUT_MS = 30_000;

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function resolveBridgeConfig(options = {}) {
  const bridgeUrl =
    options.bridgeUrl ||
    readEnv("T3CODE_DESKTOP_BROWSER_BRIDGE_URL") ||
    readEnv("T3_BROWSER_BRIDGE_URL");
  const authToken =
    options.authToken ||
    readEnv("T3CODE_DESKTOP_BROWSER_BRIDGE_TOKEN") ||
    readEnv("T3_BROWSER_BRIDGE_TOKEN");
  if (!bridgeUrl || !authToken) {
    throw new Error(
      "T3 Browser Use is unavailable because the desktop browser bridge environment is missing.",
    );
  }
  return { bridgeUrl, authToken };
}

function withProjectId(projectId, params = {}) {
  if (typeof params.projectId === "string" && params.projectId.trim().length > 0) {
    return params;
  }
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new Error("A T3 projectId is required for browser actions.");
  }
  return { ...params, projectId };
}

async function readJsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `T3 browser bridge failed with HTTP ${response.status}.`);
  }
  if (body.error) {
    throw new Error(body.error);
  }
  return body.result;
}

export class T3BrowserUse {
  constructor(options = {}) {
    const { bridgeUrl, authToken } = resolveBridgeConfig(options);
    this.bridgeUrl = bridgeUrl;
    this.authToken = authToken;
    this.projectId = options.projectId || readEnv("T3_BROWSER_PROJECT_ID");
  }

  async call(method, params = {}) {
    const response = await fetch(this.bridgeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-t3-browser-token": this.authToken,
      },
      body: JSON.stringify({ method, params: withProjectId(this.projectId, params) }),
    });
    return readJsonResponse(response);
  }

  ensure(params) {
    return this.call("browser.ensure", params);
  }

  show(params) {
    return this.call("browser.show", params);
  }

  async open(url, params = {}) {
    await this.show(params);
    if (typeof url === "string" && url.trim().length > 0) {
      return this.navigate(url, params);
    }
    return this.ensure(params);
  }

  newTab(url, params = {}) {
    return this.call("browser.new_tab", { ...params, ...(url ? { url } : {}) });
  }

  activateTab(tabId, params = {}) {
    return this.call("browser.activate_tab", { ...params, tabId });
  }

  closeTab(tabId, params = {}) {
    return this.call("browser.close_tab", { ...params, tabId });
  }

  listTabs(params) {
    return this.call("browser.list_tabs", params);
  }

  navigate(url, params = {}) {
    return this.call("browser.navigate", { ...params, url });
  }

  back(params) {
    return this.call("browser.back", params);
  }

  forward(params) {
    return this.call("browser.forward", params);
  }

  reload(params) {
    return this.call("browser.reload", params);
  }

  snapshot(params) {
    return this.call("browser.snapshot", params);
  }

  screenshot(params) {
    return this.call("browser.screenshot", params);
  }

  waitFor(input = {}) {
    return this.call("browser.wait_for", {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...input,
    });
  }

  click(selector, params = {}) {
    return this.call("browser.click", { ...params, selector });
  }

  hover(selector, params = {}) {
    return this.call("browser.hover", { ...params, selector });
  }

  fill(selector, value, params = {}) {
    return this.call("browser.fill", { ...params, selector, value });
  }

  typeText(selector, text, params = {}) {
    return this.call("browser.type_text", { ...params, selector, text });
  }

  pressKey(key, params = {}) {
    return this.call("browser.press_key", { ...params, key });
  }

  evaluate(expression, params = {}) {
    return this.call("browser.evaluate", { ...params, expression });
  }

  scrollBy(top, left = 0, params = {}) {
    const expression = `(() => {
      const cursor = window.__t3BrowserAgentCursor;
      if (cursor && typeof cursor.moveTo === "function") {
        cursor.moveTo(window.innerWidth / 2, window.innerHeight / 2, "move");
      }
      window.scrollBy({ top: ${Number(top) || 0}, left: ${Number(left) || 0}, behavior: "instant" });
      return { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight };
    })()`;
    return this.evaluate(expression, params);
  }

  getSettings(params) {
    return this.call("browser.get_settings", params);
  }
}

export function setupT3BrowserUse(options = {}) {
  const browser = new T3BrowserUse(options);
  const globals = options.globals || globalThis;
  if (globals && typeof globals === "object") {
    globals.t3Browser = browser;
  }
  return browser;
}
