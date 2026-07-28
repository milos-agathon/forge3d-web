import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { canonicalJson } from "./canonical-json.mjs";

export class MemoryLedger {
  constructor() {
    this.records = new Map();
    this.requestNonces = new Set();
  }

  reserveRequestNonce(nonce) {
    if (this.requestNonces.has(nonce)) {
      throw new Error("broker request nonce was already used");
    }
    this.requestNonces.add(nonce);
  }

  create(record) {
    if (this.records.has(record.authorizationDigest)) {
      throw new Error("authorization already has a broker issuance record");
    }
    this.records.set(record.authorizationDigest, structuredClone(record));
    return this.get(record.authorizationDigest);
  }

  get(digest) {
    const record = this.records.get(digest);
    return record ? structuredClone(record) : null;
  }

  list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  update(digest, changes) {
    const record = this.records.get(digest);
    if (!record) throw new Error("broker issuance record does not exist");
    const updated = { ...record, ...structuredClone(changes) };
    this.records.set(digest, updated);
    return structuredClone(updated);
  }
}

export class JsonFileLedger extends MemoryLedger {
  constructor(path) {
    super();
    this.path = path;
    this.load();
  }

  reserveRequestNonce(nonce) {
    super.reserveRequestNonce(nonce);
    this.persist();
  }

  create(record) {
    const result = super.create(record);
    this.persist();
    return result;
  }

  update(digest, changes) {
    const result = super.update(digest, changes);
    this.persist();
    return result;
  }

  load() {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      this.records = new Map(
        value.records.map((record) => [record.authorizationDigest, record]),
      );
      this.requestNonces = new Set(value.requestNonces);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  persist() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.new`;
    const value = {
      schemaVersion: 1,
      records: [...this.records.values()].sort((left, right) =>
        left.authorizationDigest.localeCompare(right.authorizationDigest),
      ),
      requestNonces: [...this.requestNonces].sort(),
    };
    const serialized = canonicalJson(value);
    if (serialized.includes("encoded_jit_config")) {
      throw new Error("encoded JIT configuration cannot enter the broker ledger");
    }
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
