import { expect, it } from 'vitest';
import { mapKindPolicy, mapIntegrationDiagnostic } from '../../src-ts/map-kind-policy.js';
import { getMapSceneSupportMatrix } from '../../src-ts/map-support.js';
import { prepareMapLayers } from '../../src-ts/map-layer-adapters.js';
import { validateMapRecipe } from '../../src-ts/map-validation.js';
import type { SceneRecipeInput } from '../../src-ts/index.js';

for (const kind of ['point-cloud', 'tiles3d'] as const) {
  it(`${kind}: declaration, preflight and direct execution agree on the integration block`, async () => {
    const declared = getMapSceneSupportMatrix().find(entry => entry.capability === kind)!;
    const policy = mapKindPolicy(kind);
    const input: SceneRecipeInput = {
      camera: { position: [0, 0, 10], target: [0, 0, 0] },
      output: { width: 32, height: 32 },
      layers: [{ kind, layerId: 'blocked', source: { id: 'missing', format: kind === 'tiles3d' ? 'json' : 'points' } }],
    };
    const diagnostic = mapIntegrationDiagnostic(kind, 'blocked')!;
    const preflight = validateMapRecipe(input).report;
    expect(declared.support_level).toBe(policy.level);
    expect(policy.eligible).toBe(false);
    expect(preflight.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: diagnostic.code, layer_id: 'blocked', support_level: declared.support_level }),
    ]));
    expect(preflight.layer_summaries.find(layer => layer.layer_id === 'blocked')?.support_level).toBe(declared.support_level);
    expect(preflight.unsupported_features['layer:blocked']).toBe(declared.support_level);
    const prepared = await prepareMapLayers(input, new Map(), new AbortController().signal);
    try {
      expect(prepared.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: diagnostic.code, layer_id: 'blocked', support_level: declared.support_level }),
      ]));
      expect(prepared.layerObjects.blocked).toBeUndefined();
    } finally { prepared.dispose(); }
  });
}
