import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

function receiptName(run, recordType) {
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    recordType !== "host-lab-canary"
  ) {
    throw new Error("controller receipt identity is invalid");
  }
  return `${run.id}-${run.attempt}-${recordType}.json`;
}

export function storeControllerReceipt({
  directory,
  run,
  recordType,
  signedRecord,
}) {
  if (
    signedRecord?.record?.recordType !== recordType ||
    signedRecord.record.runId !== run.id
  ) {
    throw new Error("signed controller receipt does not match its run");
  }
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = receiptName(run, recordType);
  const destination = join(root, name);
  writeFileSync(destination, `${JSON.stringify(signedRecord)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return destination;
}

export function loadControllerReceipt({
  directory,
  run,
  recordType,
}) {
  const root = resolve(directory);
  const receipt = JSON.parse(
    readFileSync(join(root, receiptName(run, recordType)), "utf8"),
  );
  if (
    receipt.record?.recordType !== recordType ||
    receipt.record.runId !== run.id
  ) {
    throw new Error("stored controller receipt identity is invalid");
  }
  return receipt;
}
