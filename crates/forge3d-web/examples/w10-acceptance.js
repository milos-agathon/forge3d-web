// Covered-pixel and negative-control checks supplement the W10 smoke scenes.
export function acceptance({api,create,camera,terrain,base,hash,delta}) {
  return {
    async aerial() {
      const r=await create();
      try {
        const cap=await r.capture({samples:1,aovs:["id"]});
        const ids=cap.aovFrame.id();
        const count=Array.from(ids).filter(x=>x>0).length;
        const diff=(a,b)=>{let sum=0;for(let i=0;i<ids.length;i++)if(ids[i]>0)for(let c=0;c<3;c++)sum+=Math.abs(a[i*4+c]-b[i*4+c]);return sum/Math.max(1,count*3);};
        const defaults={...base,sky:{model:"hosek-wilkie",aerialDensity:1,sunSize:1},sunDirection:[0.7,0.2,0.6]};
        r.setEnvironment(defaults);const baseline=await r.readRgba();
        const controls={turbidity:8,groundAlbedo:0.9,sunIntensity:4,sunSize:4,exposure:2,aerialDensity:4};
        const result={covered:count,controls:{}};
        for(const [name,value] of Object.entries(controls)) {
          r.setEnvironment({...defaults,sky:{...defaults.sky,[name]:value}});
          result.controls[name]=diff(baseline,await r.readRgba());
        }
        r.setEnvironment({...defaults,sky:{...defaults.sky,aerialPerspective:false}});const disabled=await r.readRgba();
        r.setEnvironment({...defaults,sky:{...defaults.sky,aerialPerspective:false,turbidity:8,groundAlbedo:0.9,exposure:2}});
        result.disabledDelta=diff(disabled,await r.readRgba());
        r.setEnvironment({...defaults,sky:{...defaults.sky,aerialDensity:0}});
        result.zeroDelta=diff(disabled,await r.readRgba());
        const sunrise=api.sunPosition(51.5,0,"2024-06-21T04:00:00Z");
        result.sunriseElevation=sunrise.elevation;
        r.setEnvironment({...defaults,sun:{latitude:51.5,longitude:0,utc:"2024-06-21T04:00:00Z"},sky:{model:"preetham",aerialDensity:2,sunSize:2}});
        const dawn=await r.readRgba();
        r.setEnvironment({...defaults,sun:{latitude:51.5,longitude:0,utc:"2024-06-21T12:00:00Z"},sky:{model:"preetham",aerialDensity:2,sunSize:2}});
        const noon=await r.readRgba();
        result.sunriseDelta=diff(dawn,noon);
        result.sunriseHash=await hash(dawn);
        r.setEnvironment({...defaults,sun:{latitude:51.5,longitude:0,utc:"2024-06-21T04:00:00Z"},sky:{model:"preetham",aerialDensity:2,sunSize:2}});
        result.sunriseRepeat=await hash(await r.readRgba());
        return result;
      } finally {r.dispose();}
    },
    async waterControls() {
      const r=await create();
      try {
        const water={bounds:[-25,-25,25,25],height:3,reflection:"planar",waveAmplitude:0.05,foamWidth:3};
        const settings={fresnelPower:1,hueShift:2,tintStrength:0.8,rippleScale:2,refractionStrength:1,shoreAttenuationWidth:8,waveDistortionStrength:3};
        r.setEnvironment({...base,sky:{...base.sky,aerialPerspective:false},water:[water]});
        const baseline=await r.readRgba(),result={};
        for(const [key,value] of Object.entries(settings)) {
          r.setEnvironment({...base,sky:{...base.sky,aerialPerspective:false},water:[{...water,[key]:value}]});
          result[key]=delta(baseline,await r.readRgba());
        }
        r.setEnvironment({...base,water:[{...water,mode:"disabled"}]});const disabled=await hash(await r.readRgba());
        r.setEnvironment(base);result.disabledMatches=disabled===await hash(await r.readRgba());
        return result;
      } finally {r.dispose();}
    },
    async preservation() {
      const r=await create(),scene=api.Forge3DScene.create();
      try {
        const output={};
        scene.addTerrain({...terrain,material:{layers:{snow:{enabled:true,altitudeMin:6,altitudeBlend:2}}}});
        scene.addGroundPlane({name:"ground",size:[80,80],color:[0.7,0.4,0.2,1]});
        scene.clearLights();scene.addLight({type:"directional",direction:[0.6,-0.4,0.2],color:[0.7,0.9,1],intensity:2});
        for(const kind of ["terrain-material-ground","scatter-probes"]) {
          if(kind==="scatter-probes") {
            const mesh={positions:new Float32Array([-3,0,0,3,0,0,-3,12,0,3,12,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2,2,1,3])};
            scene.setScatterBatches([new api.TerrainScatterBatch({levels:[{mesh}],transforms:api.makeScatterTransform([10,0,0]),color:[0.8,0.12,0.05,1]})]);
          }
          r.setScene(scene.snapshot());
          if(kind==="scatter-probes") {
            const golden=await (await fetch("/tests/golden/w09/probes.json")).json(),truth=golden.cases[2];
            r.setLightingProbes({grid:{origin:[0,0],spacing:[64,64],dims:[1,1],heightOffset:5,edgeBlend:[64,64]},positions:new Float32Array([0,0,0]),coefficients:new Float32Array(truth.coefficients),reflectionResolution:4,reflectionMips:truth.reflectionMips.map(m=>new Float32Array(m)),sceneBounds:{min:[-32,-32,-32],max:[32,32,32]},strength:1,reflectionStrength:1,debug:"none"});
          }
          const display=await r.readRgba();const capture=await r.capture({samples:1,aovs:["id"]});
          const hdr=capture.hdrFrame.data;
          output[kind]={display:await hash(display),hdr:await hash(new Uint8Array(hdr.buffer,hdr.byteOffset,hdr.byteLength)),covered:Array.from(capture.aovFrame.id()).filter(x=>x>0).length};
        }
        return output;
      } finally {scene.dispose();r.dispose();}
    },
  };
}
