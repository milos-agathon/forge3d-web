import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bindReviewedHelperDigests } from "../src/helper-digest-policy.mjs";
import { assertJsonSchema } from "../../../crates/forge3d-web/tests/browser/json-schema-validator.mjs";

const checked = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const versions = new Map([
  ["FORGE3D_PLAYWRIGHT_MODULE", "1.56.1"],
  ["FORGE3D_GECKODRIVER_EXECUTABLE", "0.36.0"],
  ["FORGE3D_APPIUM_EXECUTABLE", "3.0.2"],
]);
const helpers = [
  ...checked.requiredIdentities.map((identity) => ({
    identity,
    path: `/opt/forge3d/helpers/${identity.toLowerCase()}`,
    packagePath: null,
    version: versions.get(identity) ?? null,
  })),
  {
    identity: "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE",
    path: "/opt/forge3d/controller/services/session-bridge.mjs",
    packagePath: "services/unix-interactive-session-bridge.mjs",
    version: null,
  },
];

test("active helper allowlist closes every external identity on every platform", () => {
  const allowlist = ["darwin", "linux", "win32"].flatMap((platform, platformIndex) =>
    checked.requiredIdentities.map((identity, identityIndex) => ({
      identity,
      platform,
      version: versions.get(identity) ?? null,
      sha256: (platformIndex * 32 + identityIndex + 1)
        .toString(16)
        .padStart(64, "0"),
    })),
  );
  for (const platform of ["darwin", "linux", "win32"]) {
    const bound = bindReviewedHelperDigests({
      policy: {
        ...checked,
        provisioningState: "active",
        allowlist,
      },
      helpers,
      platform,
    });
    assert.equal(bound.length, helpers.length);
    assert.equal(
      bound.filter((helper) => helper.packagePath === null).every(
        (helper) => /^[0-9a-f]{64}$/u.test(helper.sha256),
      ),
      true,
    );
    assert.equal(
      bound.find((helper) => helper.identity === "FORGE3D_PLAYWRIGHT_MODULE")
        .version,
      "1.56.1",
    );
  }
});

test("checked helper policy has a closed schema", () => {
  assert.doesNotThrow(() => assertJsonSchema(checked, schema));
  assert.throws(
    () => assertJsonSchema({ ...checked, unreviewed: true }, schema),
    /schema validation failed/u,
  );
  assert.throws(
    () =>
      assertJsonSchema(
        {
          ...checked,
          provisioningState: "active",
          allowlist: [
            {
              identity: checked.requiredIdentities[0],
              platform: "linux",
              version: null,
              sha256: "not-a-digest",
            },
          ],
        },
        schema,
      ),
    /schema validation failed/u,
  );
});

test("pending or incomplete helper allowlists fail closed", () => {
  assert.throws(
    () =>
      bindReviewedHelperDigests({
        policy: checked,
        helpers,
        platform: "linux",
      }),
    /not active/u,
  );
  assert.throws(
    () =>
      bindReviewedHelperDigests({
        policy: {
          ...checked,
          provisioningState: "active",
          allowlist: [],
        },
        helpers,
        platform: "linux",
      }),
    /lacks one reviewed digest/u,
  );
});
