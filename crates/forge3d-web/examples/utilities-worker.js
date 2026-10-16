// Browser module worker: no DOM, Canvas, Node or license service.
self.onmessage=async({data:input})=>{
  const api=await import(/* @vite-ignore */ input.source?'../src-ts/index.ts':'../dist/index.js');
  const image={width:input.width,height:input.height,data:input.data,channels:4};
  const decoded=await api.pngToArray(await api.arrayToPng(image));
  self.postMessage({exact:decoded.data.every((v,i)=>v===input.data[i]),width:decoded.width,height:decoded.height});
};
