export function validSaf02Conformance({
  runId = 10, jobId = 20, commit = "a".repeat(40),
  packageSha256 = "b".repeat(64), nonce = "c".repeat(32),
} = {}) {
  const basePath = `/runs/${runId}/${jobId}/${nonce}/`;
  return { schemaVersion:1, kind:"forge3d-saf02-conformance-v1",
    binding:{lane:"safari-macos-m2",assetId:"FW-MAC-M2-01",hostId:"FW-MAC-M2-01",runId,jobId,commit,packageSha256},
    route:{applicationOrigin:"https://mac-m2.webgpu-ci.forge3d.dev",assetOrigin:"https://assets-mac-m2.webgpu-ci.forge3d.dev",basePath,nonce},
    environment:{secureContext:true,userAgent:"Safari/26",platform:"MacIntel",effectiveLaunchArguments:[]},
    wasm:{outcomes:{correctMime:"PASS",allowedCors:"PASS",badMime:"WASM_LOAD_FAILED",deniedCors:"WASM_LOAD_FAILED",wrongOriginCors:"WASM_LOAD_FAILED"},retry:{id:"saf02-one",first:"WASM_LOAD_FAILED",second:"PASS",sameRealm:true,identicalUrl:true,observersComplete:true,observed:[],configureCalls:[{format:"bgra8unorm",alphaMode:"opaque"}]}},
    terrain:{outcomes:{sameOriginFull:"PASS",allowedCorsFull:"PASS",nonzero206:"PASS",zeroOffset200:"PASS",nonzero200:"IO_ERROR",range416:"IO_ERROR",corsDeny:"IO_ERROR",corsWrongOrigin:"IO_ERROR"}},
    render:{width:77,height:53,beforeBytes:100,afterBytes:101,beforePngSignature:true,afterPngSignature:true,beforeLumaRange:21,afterLumaRange:22,visiblePixels:4081,comparedPixels:4081,changedPixels:101,cameraChanged:true,submittedFramesBeforeCamera:2,submittedFramesAfterCamera:3,configure:null},
    observers:{installedBeforeInitialization:true,restored:true,windowErrors:[],unhandledRejections:[],consoleFindings:[],deviceUncapturedErrors:[],configureCalls:[{format:"bgra8unorm",alphaMode:"opaque"},{format:"bgra8unorm",alphaMode:"premultiplied"}],viewerErrors:[]},result:"PASS"};
}
