import { validChr03HardwareProof } from "./chr03-hardware-proof-fixture.mjs";

export function validChr04HardwareProof({
  lane = "edge-linux-rtx3070", assetId = "FW-LNX-NV-01", platform = "linux",
  commit = "a".repeat(40), packageSha256 = "b".repeat(64),
} = {}) {
  const proof = validChr03HardwareProof({ lane: "chrome-linux-rtx3070", assetId, commit, packageSha256 });
  return { ...proof, kind: "forge3d-chr04-edge-hardware-proof-v1",
    binding: { lane, assetId, platform, commit, packageSha256 },
    edgeAcceptance: {
      kind: "forge3d-chr04-edge-browser-diagnostics-v1", synthetic: true, physicalPolicyProof: false,
      touch: { injectedAtBrowserBoundary: true, pointerType: "touch", pointerId: 73,
        viewChanged: true, activePointersAfter: 0, disposed: true },
      unsupported: {
        missingApi: { thrownCode: "WEBGPU_UNAVAILABLE", publicCode: "WEBGPU_UNAVAILABLE", status: "unsupported",
          unsupportedVisible: true, adapterIntercepted: null, hasBypassAdvice: false, bypassLinks: 0 },
        nullAdapter: { thrownCode: "WEBGPU_ADAPTER_UNAVAILABLE", publicCode: "WEBGPU_ADAPTER_UNAVAILABLE", status: "unsupported",
          unsupportedVisible: true, adapterIntercepted: true, hasBypassAdvice: false, bypassLinks: 0, recovered: true },
        unrelated: { code: "WASM_LOAD_FAILED", status: "WASM_LOAD_FAILED", unsupportedVisible: false },
      },
    } };
}
