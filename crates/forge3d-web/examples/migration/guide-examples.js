// Generated from docs/migration.md; source SHA-256 11c239576f9cf18a27fb03b546880c8089b66790529dd7204be30b443516d14d
export async function executeGuideExamples(api,canvas){
"use strict";
const { Forge3DRuntime, TerrainDataset } = api;
async function terrainSnapshot(canvas) {
    const dataset = TerrainDataset.fromArray({
        width: 2, height: 2,
        heights: new Float32Array([0, 0.4, 0.2, 0.8]),
        spacing: [1, 1], crs: 'LOCAL', colormap: 'terrain',
    });
    const runtime = await Forge3DRuntime.create(canvas, {
        width: 320, height: 200, devicePixelRatio: 1,
    });
    try {
        runtime.setTerrain(dataset.toTerrainInput());
        runtime.setCamera({ position: [2, 3, 4], target: [0, 0.3, 0],
            up: [0, 1, 0], near: 0.1, far: 100, fovYDegrees: 45 });
        runtime.render();
        return await runtime.screenshot();
    }
    finally {
        runtime.dispose();
    }
}
const { arrayToPng, pngToArray } = api;
async function pngRoundTrip() {
    const data = new Uint8Array([255, 80, 0, 255, 12, 34, 56, 0]);
    const blob = await arrayToPng({ width: 2, height: 1, channels: 4, data });
    const restored = await pngToArray(blob);
    if (!restored.data.every((value, index) => value === data[index])) {
        throw new Error('RGBA bytes changed');
    }
    return blob;
}

const snapshot=await terrainSnapshot(canvas),roundTrip=await pngRoundTrip();
if(snapshot.size<100||roundTrip.size<20)throw Error('Documentation examples produced no PNG');
const pixels=(await api.pngToArray(snapshot)).data;let coverage=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(pixels[i+c]-pixels[c])))>2)coverage++;
if(coverage<50)throw Error('Documentation snapshot contains only clear RGB');
return {snapshotBytes:snapshot.size,roundTripBytes:roundTrip.size,snapshotCoverage:coverage};
}
