import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { VectorScene } from '../../src-ts/vector-export-scene.js';
import { exportPdf } from '../../src-ts/vector-pdf.js';
vi.mock('../../src-ts/vendor/fontkit-entry.js', async importOriginal => {
  const { default: real } = await importOriginal<typeof import('../../src-ts/vendor/fontkit-entry.js')>();
  return { default: { ...real, create(bytes: Uint8Array) { const font = real.create(bytes); font.layout = () => { throw Error('backend shaping failed'); }; return font; } } };
});
it('fontkit shaping failures are structured, preserving the actual cause', async () => {
  const scene = new VectorScene().addLabel('Valid label', [0, 0]);
  const fonts = [{ family: 'DejaVu Sans', source: readFileSync(new URL('../../assets/fonts/DejaVuSans.ttf', import.meta.url)) }];
  await expect(exportPdf(scene, { fonts })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', details: { reason: 'pdf-export-failed', cause: 'Error: backend shaping failed' } });
  await expect(exportPdf(scene, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  scene.dispose();
});
