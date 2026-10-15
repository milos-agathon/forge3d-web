import {
  LicenseManager, licenseManager, requiresPro, setLicenseKey, getLicenseInfo,
  arrayToPng, pngToArray, decodePng, displayImageArray, runBenchmark, runBenchmarkSuite,
  RendererConfig, Forge3DSession,
  type BenchmarkOptions, type BenchmarkResult, type ImageArray, type LicenseInfo,
  type PersistentByteStore,
} from '../../types/index.js';

async function contracts(canvas: HTMLCanvasElement, store: PersistentByteStore): Promise<void> {
  const manager = new LicenseManager({ verifier: 'noble' });
  const info: LicenseInfo = await manager.setKey('');
  await manager.save(store); await licenseManager.load(store);
  await setLicenseKey(''); void getLicenseInfo(); void info;
  const wrapped = requiresPro((n: number): string => String(n), 'test');
  const value: string = wrapped(2); void value;
  const image: ImageArray = { width: 1, height: 1, channels: 4, data: new Uint8Array(4) };
  const blob: Blob = await arrayToPng(image), pixels = await pngToArray(blob);
  decodePng(new Uint8Array(await blob.arrayBuffer()));
  displayImageArray(canvas, { ...pixels, channels: 4 });
  const target = await Forge3DSession.create(canvas);
  const options: BenchmarkOptions = { op: 'renderer_rgba', width: 1, height: 1, target, renderer: new RendererConfig() };
  const result: BenchmarkResult = await runBenchmark(options);
  const schema: 1 = result.schemaVersion; void schema;
  await runBenchmarkSuite([options]); target.dispose();
  // @ts-expect-error float samples are not uint8 image arrays
  const floats: ImageArray = { width: 1, height: 1, channels: 4, data: new Float32Array(4) }; void floats;
  // @ts-expect-error unknown operations must not silently run
  void runBenchmark({op:'other',width:1,height:1});
}
void contracts;
