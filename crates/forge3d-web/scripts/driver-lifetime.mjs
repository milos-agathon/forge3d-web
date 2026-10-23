import { registerProcess, markProcessStopped, stopChild } from "./browser-process-registry.mjs";

/** Own resources immediately after acquisition, before publishing or observing them. */
export class DriverLifetime {
  #resources = [];
  #closing;
  constructor(registryPath, adapters = {}) {
    this.path = registryPath;
    this.adapters = { registerProcess, markProcessStopped, stopChild, ...adapters };
  }
  own(close) { this.#resources.push(close); }
  process(child, name) {
    let registered = false;
    child.on?.("error", () => {}); // Spawn errors must not become unhandled while readiness unwinds.
    this.own(async () => {
      await this.adapters.stopChild(child);
      if (registered) this.adapters.markProcessStopped(this.path, child.pid);
    });
    this.adapters.registerProcess(this.path, name, child.pid);
    registered = true;
    return child;
  }
  session(session) { this.own(() => session.delete()); return session; }
  composite(session, name) {
    let registered = false;
    this.own(async () => {
      const result = await session.close();
      if (result?.ok !== true || result.processAbsent !== true) {
        throw new Error("INFRA_ERROR DRIVER_CLEANUP_UNPROVEN");
      }
      if (registered) this.adapters.markProcessStopped(this.path, session.driverPid);
      return result;
    });
    this.adapters.registerProcess(this.path, name, session.driverPid);
    registered = true;
    return session;
  }
  close() {
    return this.#closing ??= (async () => {
      const errors = [];
      let result;
      for (const close of this.#resources.reverse()) {
        try { result = await close() ?? result; } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "INFRA_ERROR DRIVER_CLEANUP_UNPROVEN");
      return result;
    })();
  }
  async fail(error) {
    try { await this.close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "INFRA_ERROR DRIVER_SETUP_AND_CLEANUP_FAILED", { cause: error });
    }
    throw error;
  }
}
