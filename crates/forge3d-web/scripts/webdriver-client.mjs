export class WebDriverClient {
  constructor(baseUrl, fetchImpl = fetch, requestTimeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async waitUntilReady() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/status`).catch(
        () => null,
      );
      if (response?.ok) return;
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

  async request(method, path, body = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
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
    if (!response.ok || value.value?.error) {
      throw new Error(`INFRA_ERROR WEBDRIVER_REQUEST_FAILED ${method} ${response.status}`);
    }
    return value;
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
    );
    const result = response.value;
    if (result?.ok !== true) {
      throw new Error("INFRA_ERROR BROWSER_PAGE_FAILED");
    }
    return result.value;
  }

  async runRouteProbe({ route, expectedPackageSha256 }) {
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
    );
    const result = response.value;
    if (result?.ok !== true) {
      throw new Error("INFRA_ERROR BROWSER_ROUTE_PROBE_FAILED");
    }
    return result.value;
  }

  delete() {
    return this.client.request(
      "DELETE",
      `/session/${this.sessionId}`,
    );
  }
}
