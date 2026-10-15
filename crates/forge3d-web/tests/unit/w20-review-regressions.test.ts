import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseColormapJson } from '../../src-ts/colormap-io.js';
import { colormapFromStops } from '../../src-ts/colormaps.js';
import { Legend } from '../../src-ts/map-legend.js';
import { ScaleBar } from '../../src-ts/map-scale-bar.js';
import { NorthArrow } from '../../src-ts/map-north-arrow.js';

it('native stop strings ignore a trailing hex alpha while numeric RGBA retains it', () => {
  const oracle = JSON.parse(readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url), 'utf8'));
  for (const c of oracle.stopCases) {
    for (const actual of [colormapFromStops(c.name, c.stops, c.size), parseColormapJson(JSON.stringify({ name: c.name, stops: c.stops }), c.size)]) {
      expect(actual.rgba.length).toBe(c.rgba.length); actual.rgba.forEach((v, i) => expect(Math.abs(v - c.rgba[i]), c.name).toBeLessThan(7e-7));
    }
  }
  expect(colormapFromStops('hex', [[0, '#ffffff80'], [1, '#ffffff80']], 3).sample(.5)).toEqual([1, 1, 1, 1]);
  expect(colormapFromStops('rgba', [[0, [1, 1, 1, .5]], [1, [1, 1, 1, .5]]], 3).sample(.5)).toEqual([1, 1, 1, .5]);
});
it('native repeated stops form a right-continuous hard edge', () => {
  expect(Array.from(colormapFromStops('edge', [[0, '#000000'], [.5, '#000000'], [.5, '#ffffff'], [1, '#ffffff']], 5).rgba).filter((_, i) => i % 4 === 0)).toEqual([0, 0, 1, 1, 1]);
});
it('native stops outside the sample domain still participate in interpolation', () => {
  expect(Array.from(colormapFromStops('extended', [[-.5, '#000000'], [1.5, '#ffffff']], 3).rgba).filter((_, i) => i % 4 === 0)).toEqual([.25, .5, .75]);
});
for (const [name, furniture] of [['legend', new Legend(colormapFromStops('gray', [[0, '#000000'], [1, '#ffffff']]), [0, 1])], ['scale', new ScaleBar(100)], ['arrow', new NorthArrow()]] as const) {
  it(`${name} rejects cancellation before fonts or canvas allocation`, async () => {
    await expect(furniture.render({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
  it(`${name} admits its budget before fonts or canvas allocation`, async () => {
    await expect(furniture.render({ maxBytes: 1 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  });
}
