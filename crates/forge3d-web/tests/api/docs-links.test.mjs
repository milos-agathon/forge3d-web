import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const documents = [
  "README.md",
  "docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md",
  "crates/forge3d-web/README.md",
  "crates/forge3d-web/docs/support-matrix.md",
  "crates/forge3d-web/docs/release-checklist.md",
];
const githubDocumentPattern = /^https:\/\/github\.com\/milos-agathon\/forge3d\/blob\/main\/([^#]+)(?:#(.+))?$/u;
const markdownLinkPattern = /\[[^\]]+\]\(([^)\s]+)\)/gu;

for (const relativeDocumentPath of documents) {
  test(`${relativeDocumentPath} has no broken repository documentation links`, () => {
    const documentPath = resolve(repositoryRoot, relativeDocumentPath);
    const document = readFileSync(documentPath, "utf8");

    for (const match of document.matchAll(markdownLinkPattern)) {
      const target = resolveDocumentationTarget(documentPath, match[1]);
      if (target === null) {
        continue;
      }

      const repositoryRelativeTarget = relative(repositoryRoot, target.path);
      assert(
        repositoryRelativeTarget !== "" && !repositoryRelativeTarget.startsWith("..") && !isAbsolute(repositoryRelativeTarget),
        `${relativeDocumentPath} link escapes the repository: ${match[1]}`,
      );
      assert(existsSync(target.path), `${relativeDocumentPath} link target does not exist: ${match[1]}`);

      if (target.fragment !== undefined) {
        const targetDocument = readFileSync(target.path, "utf8");
        const headings = new Set(
          [...targetDocument.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((heading) => githubSlug(heading[1])),
        );
        assert(
          headings.has(decodeURIComponent(target.fragment)),
          `${relativeDocumentPath} link fragment does not exist: ${match[1]}`,
        );
      }
    }
  });
}

test("documented feature gaps link to a capability row and owning task", () => {
  const packageReadme = readFileSync(resolve(repositoryRoot, "crates/forge3d-web/README.md"), "utf8");
  const supportMatrix = readFileSync(resolve(repositoryRoot, "crates/forge3d-web/docs/support-matrix.md"), "utf8");
  const gapRows = `${packageReadme}\n${supportMatrix}`
    .split("\n")
    .filter((line) => line.includes("| Current gap |") || line.includes("| Tracked feature gap |"));

  assert(gapRows.length > 0, "expected at least one documented feature-gap row");
  for (const row of gapRows) {
    assert.match(row, /\[(?:R|C|T|P|V|G|M)\d{2}/u, `feature gap lacks a linked capability row: ${row}`);
    assert.match(row, /\[W\d{2}\]/u, `feature gap lacks a linked owning task: ${row}`);
  }
  assert.doesNotMatch(
    `${packageReadme}\n${supportMatrix}`,
    /\| [^|]+ \| Unsupported \|/u,
    "unsupported capability rows must be classified as a tracked gap or explicit product boundary",
  );
});

function resolveDocumentationTarget(documentPath, href) {
  const githubMatch = githubDocumentPattern.exec(href);
  if (githubMatch !== null) {
    return {
      path: resolve(repositoryRoot, decodeURIComponent(githubMatch[1])),
      fragment: githubMatch[2],
    };
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(href)) {
    return null;
  }

  const [pathPart, fragment] = href.split("#", 2);
  return {
    path: pathPart.length === 0 ? documentPath : resolve(dirname(documentPath), decodeURIComponent(pathPart)),
    fragment,
  };
}

function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\- _]/gu, "")
    .replace(/ /gu, "-");
}
