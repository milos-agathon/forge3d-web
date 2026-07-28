import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const usesMatch = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)(?:\s+#.*)?$/u);
    if (usesMatch) {
      const uses = unquote(usesMatch[1]);
      if (uses.startsWith("./") || uses.startsWith("docker://")) {
        throw new Error(
          `${source}:${index + 1} local and docker action references are forbidden`,
        );
      }
      if (uses.includes("${{")) {
        throw new Error(
          `${source}:${index + 1} action references cannot contain expressions`,
        );
      }
      const match = uses.match(
        /^([^/@\s]+\/[^/@\s]+)(\/[^@\s]+)?@([0-9a-f]{40})$/u,
      );
      if (!match) {
        throw new Error(
          `${source}:${index + 1} action must use a full lowercase commit SHA: ${uses}`,
        );
      }
      const repository = match[1];
      const actionPath = match[2]?.slice(1) ?? "";
      const commit = match[3];
      const key = actionKey(repository, actionPath);
      const locked = lockedActions.get(key);
      if (!locked) {
        throw new Error(`${source}:${index + 1} action is not reviewed in lockfile: ${key}`);
      }
      if (locked.commit !== commit) {
        throw new Error(
          `${source}:${index + 1} action commit disagrees with lockfile: ${key}`,
        );
      }
      references.push({ source, line: index + 1, repository, path: actionPath, commit });
    }

    const imageMatch = line.match(
      /^\s*(?:container|image):\s*["']?([^"'#\s]+)["']?(?:\s+#.*)?$/u,
    );
    if (imageMatch && !/@sha256:[0-9a-f]{64}$/u.test(imageMatch[1])) {
      throw new Error(
        `${source}:${index + 1} job and service container images must use a sha256 digest`,
      );
    }
  }
  return references;
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

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
