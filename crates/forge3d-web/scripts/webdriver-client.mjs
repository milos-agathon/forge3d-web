export class WebDriverClient {
  constructor(baseUrl, fetchImpl = fetch, requestTimeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async waitUntilReady() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await this.requestRaw("GET", "/status", undefined, 2_000).catch(() => null);
      if (response?.http.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`WebDriver did not become ready at ${this.baseUrl}`);
  }

  async createSession(capabilities) {
    const response = await this.request("POST", "/session", {
      capabilities: { alwaysMatch: capabilities },
    });
    const value = response.value ?? response;
    const sessionId = value.sessionId ?? response.sessionId;
    if (!sessionId) throw new Error("WebDriver did not return a session ID");
    return new WebDriverSession(
      this,
      sessionId,
      value.capabilities ?? response.capabilities ?? {},
    );
  }

  async request(method, path, body = undefined, timeoutMs = this.requestTimeoutMs) {
    const response = await this.requestRaw(method, path, body, timeoutMs);
    const { value, http } = response;
    if (!http.ok || value.value?.error) {
      throw new Error(`INFRA_ERROR WEBDRIVER_REQUEST_FAILED ${method} ${http.status}`);
    }
    return value;
  }

  async requestRaw(method, path, body = undefined, timeoutMs = this.requestTimeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let value;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      value = await response.json();
    } catch {
      throw new Error(`INFRA_ERROR WEBDRIVER_REQUEST_FAILED ${method}`);
    } finally {
      clearTimeout(timeout);
    }
    return { http: response, value };
  }
}

class WebDriverSession {
  constructor(client, sessionId, capabilities) {
    this.client = client;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }

  navigate(url) {
    return this.client.request(
      "POST",
      `/session/${this.sessionId}/url`,
      { url },
    );
  }

  async browserInfo() {
    return {
      version: String(
        this.capabilities.browserVersion ??
          this.capabilities.version ??
          "unknown",
      ),
      platformVersion: String(this.capabilities.platformVersion ?? "unknown"),
    };
  }

  async currentUrl() {
    const response = await this.client.request(
      "GET",
      `/session/${this.sessionId}/url`,
    );
    if (typeof response.value !== "string" || !/^https:\/\//u.test(response.value)) {
      throw new Error("INFRA_ERROR WEBDRIVER_SESSION_STATE_INVALID");
    }
    return response.value;
  }

  async runHardwarePage(payload) {
    await this.client.request("POST", `/session/${this.sessionId}/timeouts`, { script: 115_000 });
    const script = `
      const payload = arguments[0];
      const done = arguments[arguments.length - 1];
      import(new URL("hardware-page-harness.js", window.location.href).href)
        .then((module) => module.runHardwarePage(payload))
        .then((value) => done({ ok: true, value }))
        .catch((error) => done({ ok: false, error: String(error && error.message || error) }));
    `;
    const response = await this.client.request(
      "POST",
      `/session/${this.sessionId}/execute/async`,
      { script, args: [payload] },
      120_000,
    );
    const result = response.value;
    if (result?.ok !== true) {
      throw new Error("INFRA_ERROR BROWSER_PAGE_FAILED");
    }
    return result.value;
  }

  async runRouteProbe({ route, expectedPackageSha256 }) {
    await this.client.request("POST", `/session/${this.sessionId}/timeouts`, { script: 25_000 });
    const script = `
      const payload = arguments[0];
      const done = arguments[arguments.length - 1];
      import(new URL("hardware-page-harness.js", window.location.href).href)
        .then((module) => module.verifyBrowserRoute(
          payload.route,
          payload.expectedPackageSha256,
        ))
        .then((value) => done({ ok: true, value }))
        .catch((error) => done({ ok: false, error: String(error && error.message || error) }));
    `;
    const response = await this.client.request(
      "POST",
      `/session/${this.sessionId}/execute/async`,
      { script, args: [{ route, expectedPackageSha256 }] },
      30_000,
    );
    const result = response.value;
    if (result?.ok !== true) {
      throw new Error("INFRA_ERROR BROWSER_ROUTE_PROBE_FAILED");
    }
    return result.value;
  }

  async runBfcacheLifecycleAction(action, args = []) {
    const exports = new Set([
      "prepareViewerBfcacheCycle",
      "observeViewerBfcacheRestore",
      "exerciseViewerAfterBfcache",
      "disposeViewerBfcacheLifecycle",
    ]);
    if (!exports.has(action) || !Array.isArray(args)) {
      throw new Error("INFRA_ERROR WEBDRIVER_BFCACHE_ACTION_INVALID");
    }
    const script = `
      const action = arguments[0];
      const values = arguments[1];
      const done = arguments[arguments.length - 1];
      import(new URL("viewer-bfcache-lifecycle.js", window.location.href).href)
        .then((module) => module[action](...values))
        .then((value) => done({ ok: true, value }))
        .catch((error) => done({ ok: false, message: String(error && error.message || error) }));
    `;
    const response = await this.client.request(
      "POST",
      `/session/${this.sessionId}/execute/async`,
      { script, args: [action, args] },
    );
    if (response.value?.ok !== true) {
      throw new Error(`INFRA_ERROR WEBDRIVER_BFCACHE_ACTION_FAILED ${action}`);
    }
    return response.value.value;
  }

  historyBack() {
    return this.client.request(
      "POST",
      `/session/${this.sessionId}/back`,
      {},
    );
  }

  delete() {
    return this.client.request(
      "DELETE",
      `/session/${this.sessionId}`,
    );
  }
}
