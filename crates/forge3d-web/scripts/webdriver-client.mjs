export class WebDriverClient {
  constructor(baseUrl, fetchImpl = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
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
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value.value?.error) {
      throw new Error(
        `WebDriver ${method} ${path} failed: ${
          value.value?.message ?? response.status
        }`,
      );
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
    };
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
      throw new Error(`browser hardware page failed: ${result?.error}`);
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
