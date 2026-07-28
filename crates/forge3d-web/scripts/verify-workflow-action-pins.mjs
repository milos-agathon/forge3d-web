import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");
const lockPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "workflow-actions-lock.json",
);

export function verifyWorkflowActionPins({
  root = repositoryRoot,
  lock = JSON.parse(readFileSync(lockPath, "utf8")),
} = {}) {
  const lockedActions = new Map();
  for (const entry of lock.actions) {
    const key = actionKey(entry.repository, entry.path);
    if (lockedActions.has(key)) {
      throw new Error(`duplicate action lock entry: ${key}`);
    }
    if (!/^[0-9a-f]{40}$/.test(entry.commit)) {
      throw new Error(`action lock commit is not a full lowercase SHA: ${key}`);
    }
    lockedActions.set(key, entry);
  }

  const checkedFiles = findCheckedYamlFiles(root);
  if (checkedFiles.length === 0) {
    throw new Error("no GitHub workflow or composite action files were found");
  }

  const references = [];
  for (const path of checkedFiles) {
    const text = readFileSync(path, "utf8");
    references.push(
      ...verifyWorkflowText(text, repositoryPath(root, path), lockedActions),
    );
  }

  return {
    checkedFiles: checkedFiles.map((path) => repositoryPath(root, path)),
    references,
  };
}

export function verifyWorkflowText(text, source, lockedActions) {
  const references = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    lineCounter,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${source} is not valid unambiguous YAML: ${document.errors[0].message}`,
    );
  }
  collectActionReferences(
    document.contents,
    source,
    lockedActions,
    lineCounter,
    references,
  );
  const jobs = mapValue(document.contents, "jobs");
  if (jobs !== undefined) {
    if (!isMap(jobs)) {
      throw new Error(`${source} workflow jobs must be a mapping`);
    }
    for (const jobPair of jobs.items) {
      if (!isMap(jobPair.value)) continue;
      verifyJobContainerImages(jobPair.value, source, lineCounter);
    }
  }
  return references;
}

function collectActionReferences(
  node,
  source,
  lockedActions,
  lineCounter,
  references,
) {
  if (isAlias(node)) {
    throw new Error(
      `${source}:${nodeLine(node, lineCounter)} YAML aliases are forbidden in pinned workflow and action files`,
    );
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (scalarValue(pair.key) === "uses") {
        const line = nodeLine(pair.value ?? pair.key, lineCounter);
        const uses = requireStringScalar(
          pair.value,
          `${source}:${line} action reference`,
        );
        if (uses.startsWith("./") || uses.startsWith("docker://")) {
          throw new Error(
            `${source}:${line} local and docker action references are forbidden`,
          );
        }
        if (uses.includes("${{")) {
          throw new Error(
            `${source}:${line} action references cannot contain expressions`,
          );
        }
        const match = uses.match(
          /^([^/@\s]+\/[^/@\s]+)(\/[^@\s]+)?@([0-9a-f]{40})$/u,
        );
        if (!match) {
          throw new Error(
            `${source}:${line} action must use a full lowercase commit SHA: ${uses}`,
          );
        }
        const repository = match[1];
        const actionPath = match[2]?.slice(1) ?? "";
        const commit = match[3];
        const key = actionKey(repository, actionPath);
        const locked = lockedActions.get(key);
        if (!locked) {
          throw new Error(
            `${source}:${line} action is not reviewed in lockfile: ${key}`,
          );
        }
        if (locked.commit !== commit) {
          throw new Error(
            `${source}:${line} action commit disagrees with lockfile: ${key}`,
          );
        }
        references.push({
          source,
          line,
          repository,
          path: actionPath,
          commit,
        });
      }
      collectActionReferences(
        pair.value,
        source,
        lockedActions,
        lineCounter,
        references,
      );
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      collectActionReferences(
        item,
        source,
        lockedActions,
        lineCounter,
        references,
      );
    }
  }
}

function verifyJobContainerImages(job, source, lineCounter) {
  const container = mapValue(job, "container");
  if (container !== undefined) {
    const image = isMap(container) ? mapValue(container, "image") : container;
    verifyContainerImage(image, source, lineCounter);
  }
  const services = mapValue(job, "services");
  if (services === undefined) return;
  if (!isMap(services)) {
    throw new Error(`${source} job services must be a mapping`);
  }
  for (const servicePair of services.items) {
    if (!isMap(servicePair.value)) {
      throw new Error(
        `${source}:${nodeLine(servicePair.value ?? servicePair.key, lineCounter)} service configuration must be a mapping`,
      );
    }
    verifyContainerImage(
      mapValue(servicePair.value, "image"),
      source,
      lineCounter,
    );
  }
}

function verifyContainerImage(node, source, lineCounter) {
  const line = nodeLine(node, lineCounter);
  const image = requireStringScalar(
    node,
    `${source}:${line} container image`,
  );
  if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(image)) {
    throw new Error(
      `${source}:${line} job and service container images must use a literal sha256 digest`,
    );
  }
}

function mapValue(node, key) {
  if (!isMap(node)) return undefined;
  return node.items.find((pair) => scalarValue(pair.key) === key)?.value;
}

function scalarValue(node) {
  return isScalar(node) ? node.value : undefined;
}

function requireStringScalar(node, label) {
  if (!isScalar(node) || typeof node.value !== "string") {
    throw new Error(`${label} must be a scalar string`);
  }
  return node.value;
}

function nodeLine(node, lineCounter) {
  return lineCounter.linePos(node?.range?.[0] ?? 0).line;
}

function findCheckedYamlFiles(root) {
  const workflowDirectory = join(root, ".github", "workflows");
  const files = readdirSync(workflowDirectory)
    .filter((name) => [".yml", ".yaml"].includes(extname(name)))
    .map((name) => join(workflowDirectory, name));
  walk(root, files);
  return [...new Set(files)].sort();
}

function walk(directory, files) {
  for (const entry of readdirSync(directory)) {
    if ([".git", "node_modules", "target", "dist", "pkg"].includes(entry)) {
      continue;
    }
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path, files);
    } else if (
      (entry === "action.yml" || entry === "action.yaml") &&
      !path.includes(`${join(".github", "workflows")}`)
    ) {
      files.push(path);
    }
  }
}

function actionKey(repository, path) {
  return path ? `${repository}/${path}` : repository;
}

function repositoryPath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyWorkflowActionPins();
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedFileCount: result.checkedFiles.length,
        actionReferenceCount: result.references.length,
      },
      null,
      2,
    ),
  );
}
