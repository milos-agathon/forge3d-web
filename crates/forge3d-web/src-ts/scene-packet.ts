import { Forge3DError } from './runtime-failure.js';
import type { SceneSnapshot } from './index.js';
import { Forge3DScene, clonePayload, restoreSceneIbl, restoreSceneLighting, restoreSceneMaterials, restoreSceneShadows } from './scene.js';
import { defaultShadowSnapshot } from './shadows.js';
import { collectTransfer } from './owned-transfer.js';
/** The sendable graph and retained identity never alias caller-owned buffers. */
export function prepareScenePacket(scene: Forge3DScene) {
  const copy=scene.copy();
  try {
    const committed=copy.snapshot(),snapshot=clonePayload(committed);
    return {snapshot,committed,transfer:collectTransfer(snapshot)};
  } finally { copy.dispose(); }
}
export function reconstructScene(snapshot: SceneSnapshot): Forge3DScene {
  const scene = Forge3DScene.create();
  const ids = new Map<number, number>();
  for (const node of snapshot.nodes) {
    const id = scene.addNode(node.node);
    ids.set(node.id, id);
    if (node.parent !== null) {
      const parent = ids.get(node.parent);
      if (parent === undefined) {
        throw new Forge3DError(
          "INVALID_INPUT",
          `scene node ${node.id} references unknown or later parent ${node.parent}`,
        );
      }
      scene.setParent(id, parent);
    }
    scene.setTransform(id, node.transform);
    if (!node.visible) {
      scene.setVisible(id, false);
    }
  }
  for (const pass of snapshot.passes) {
    scene.addPass(pass);
  }
  if (snapshot.lighting !== undefined) {
    restoreSceneLighting(scene, snapshot.environmentLighting ?? snapshot.lighting);
  }
  if (snapshot.materials !== undefined) {
    restoreSceneMaterials(scene, snapshot.materials);
  }
  restoreSceneIbl(scene, snapshot.ibl ?? null);
  restoreSceneShadows(scene, snapshot.shadows ?? defaultShadowSnapshot());
  if (snapshot.environment !== undefined) scene.setEnvironment(snapshot.environment);
  if (snapshot.vectors !== undefined) scene.setVectorLayers(snapshot.vectors);
  if (snapshot.postFx !== undefined) scene.setPostFx(snapshot.postFx);
  if (snapshot.scatter !== undefined) scene.setScatterBatches(snapshot.scatter);
  if (snapshot.probes !== undefined) scene.setLightingProbes(snapshot.probes);
  if (snapshot.timeSeconds !== undefined) scene.setTimeSeconds(snapshot.timeSeconds);
  return scene;
}
