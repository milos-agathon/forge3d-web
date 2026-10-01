import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";
import { writeFileSync } from "node:fs";

test("W10 terrain agrees with independently rendered native and historical scenes", async ({page,webgpuAvailability}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w07-materials.html");
  await page.waitForFunction(() => typeof (window as any).__w10NativeTerrain === "function");
  const results = await page.evaluate(() => (window as any).__w10NativeTerrain());
  console.log("Native results",Object.fromEntries(Object.entries<any>(results).map(([k,v])=>[k,{...v,actual:undefined}])));
  for(const [name,r] of Object.entries<any>(results)) {
    writeFileSync(`test-results/w10-${name}-web.rgba`,Buffer.from(r.actual));
    expect(r.ssim,name).toBeGreaterThanOrEqual(0.98);
    expect(r.historicalSsim,name).toBeGreaterThanOrEqual(0.98);
    if(r.controlSsim!==undefined)expect(r.controlSsim,name).toBeLessThan(0.98);
  }
});
