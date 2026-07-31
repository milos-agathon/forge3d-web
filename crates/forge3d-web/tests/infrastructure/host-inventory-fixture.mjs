export function exactHostInventory(matrix, hostId) {
  const host = matrix.hosts.find((candidate) => candidate.assetId === hostId);
  if (!host) throw new Error(`unknown fixture host ${hostId}`);
  const platform = {
    macOS: "darwin",
    Windows: "win32",
    Ubuntu: "linux",
  }[host.os.family];
  const attachedAssets = host.attachedAssetIds.map((assetId) => {
    const asset = matrix.assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) throw new Error(`missing fixture attachment ${assetId}`);
    return {
      assetId: asset.assetId,
      model: asset.model,
      appiumId: asset.appiumId,
    };
  });
  const inventory = {
    schemaVersion: 1,
    assetId: host.assetId,
    platform,
    model: host.model,
    cpu: host.cpu,
    gpu: host.gpu,
    ramGiB: host.ramGiB,
    osBuild: `${host.os.family} fixture build`,
    headed: true,
    displayServer: host.displayServer,
    session: {
      interactive: true,
      locked: false,
      remote: false,
      identifier: "fixture-console",
    },
    browsers: [
      {
        id: "chrome-stable",
        channel: "stable",
        classification: "required",
        automation: "playwright",
        version: "150.0.0.0",
        executable: "/fixture/chrome",
      },
    ],
    tools: {
      playwright: "1.56.1",
      selenium: "4.35.0",
      geckodriver: "0.36.0",
    },
    effectiveLaunchArguments: [],
    prohibitedLaunchArgumentsPresent: [],
    attachedAssetIds: attachedAssets.map(({ assetId }) => assetId),
    attachedAssets,
    trackpad: null,
    capturedAt: "2026-07-29T08:00:00.000Z",
  };
  if (hostId === "FW-MAC-M2-01") {
    const trackpad = matrix.assets.find(
      (asset) => asset.assetId === "FW-TRACKPAD-01",
    );
    inventory.trackpad = {
      assetId: trackpad.assetId,
      model: trackpad.model,
      firmware: "3.1.2",
      transport: "Bluetooth",
      batteryState: "87%",
      capturedAt: "2026-07-29T07:59:00.000Z",
      topology: {
        pairingAndCharging: "direct-usb-c-to-usb-c",
        gestures: "bluetooth",
        hubPresent: false,
      },
    };
  }
  return inventory;
}
