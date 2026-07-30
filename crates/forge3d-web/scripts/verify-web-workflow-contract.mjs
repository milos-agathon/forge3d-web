import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "web.yml");

const requiredJobs = new Map([
  [
    "build-and-contract",
    {
      name: "Web Runtime / Build And Contract Tests",
      needs: null,
      runsOn: "windows-latest",
    },
  ],
  [
    "browser-preflight",
    {
      name: "Web Runtime / Browser Preflight",
      needs: "build-and-contract",
      runsOn: "macos-15",
    },
  ],
]);

export function verifyWebWorkflowContract(
  text = readFileSync(workflowPath, "utf8"),
) {
  const parsed = parseWorkflowStructure(text);
  const triggerNames = [...parsed.triggers.keys()].sort();
  if (
    triggerNames.length !== 2 ||
    triggerNames[0] !== "pull_request" ||
    triggerNames[1] !== "push"
  ) {
    throw new Error(
      `web workflow triggers must be exactly pull_request and push, got ${triggerNames.join(", ")}`,
    );
  }
  for (const trigger of triggerNames) {
    const branches = parsed.triggers.get(trigger).branches;
    if (branches.length !== 1 || branches[0] !== "main") {
      throw new Error(`${trigger} must target only main`);
    }
  }

  if (parsed.jobs.size !== requiredJobs.size) {
    throw new Error(`web workflow must contain exactly ${requiredJobs.size} jobs`);
  }
  const displayNames = new Set();
  for (const [jobId, expected] of requiredJobs) {
    const job = parsed.jobs.get(jobId);
    if (!job) {
      throw new Error(`web workflow is missing required job ${jobId}`);
    }
    if (job.name !== expected.name) {
      throw new Error(
        `${jobId} display name must remain immutable: ${expected.name}`,
      );
    }
    if (displayNames.has(job.name)) {
      throw new Error(`duplicate job display name: ${job.name}`);
    }
    displayNames.add(job.name);
    if (job.runsOn !== expected.runsOn) {
      throw new Error(
        `${jobId} runner must remain ${expected.runsOn}, got ${job.runsOn ?? "absent"}`,
      );
    }
    if ((job.needs ?? null) !== expected.needs) {
      throw new Error(
        `${jobId} needs must be ${expected.needs ?? "absent"}`,
      );
    }
  }

  return {
    triggers: triggerNames,
    jobs: [...parsed.jobs].map(([id, job]) => ({ id, ...job })),
  };
}

export function parseWorkflowStructure(text) {
  const topLevel = new Set();
  const triggers = new Map();
  const jobs = new Map();
  let section = null;
  let currentTrigger = null;
  let currentJob = null;

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    if (rawLine.includes("\t")) {
      throw new Error(`web workflow line ${index + 1} contains a tab`);
    }
    const content = rawLine.replace(/\s+#.*$/u, "").trimEnd();
    if (content.trim() === "" || content.trimStart().startsWith("#")) {
      continue;
    }
    const indent = content.length - content.trimStart().length;
    const trimmed = content.trim();

    if (indent === 0) {
      const key = mappingKey(trimmed, index);
      if (topLevel.has(key)) {
        throw new Error(`duplicate top-level workflow key: ${key}`);
      }
      topLevel.add(key);
      section = key;
      currentTrigger = null;
      currentJob = null;
      continue;
    }

    if (section === "on") {
      if (indent === 2) {
        const key = mappingKey(trimmed, index);
        if (triggers.has(key)) {
          throw new Error(`duplicate workflow trigger: ${key}`);
        }
        triggers.set(key, { branches: [] });
        currentTrigger = key;
      } else if (indent === 4 && currentTrigger) {
        const match = trimmed.match(/^branches:\s*(.+)$/u);
        if (match) {
          triggers.get(currentTrigger).branches = parseInlineArray(match[1]);
        }
      }
      continue;
    }

    if (section === "jobs") {
      if (indent === 2) {
        const key = mappingKey(trimmed, index);
        if (jobs.has(key)) {
          throw new Error(`duplicate workflow job id: ${key}`);
        }
        jobs.set(key, { name: null, runsOn: null, needs: null });
        currentJob = key;
      } else if (indent === 4 && currentJob) {
        const match = trimmed.match(/^(name|runs-on|needs):\s*(.+)$/u);
        if (match) {
          const property = {
            name: "name",
            "runs-on": "runsOn",
            needs: "needs",
          }[match[1]];
          if (jobs.get(currentJob)[property] !== null) {
            throw new Error(`duplicate ${match[1]} in job ${currentJob}`);
          }
          jobs.get(currentJob)[property] = unquote(match[2].trim());
        }
      }
    }
  }
  return { triggers, jobs };
}

function mappingKey(value, index) {
  const match = value.match(/^([A-Za-z0-9_-]+):(?:\s.*)?$/u);
  if (!match) {
    throw new Error(`expected YAML mapping key at line ${index + 1}`);
  }
  return match[1];
}

function parseInlineArray(value) {
  const match = value.match(/^\[(.*)\]$/u);
  if (!match) {
    throw new Error("branch filters must use an explicit inline array");
  }
  return match[1]
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
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
  console.log(JSON.stringify({ ok: true, ...verifyWebWorkflowContract() }, null, 2));
}
