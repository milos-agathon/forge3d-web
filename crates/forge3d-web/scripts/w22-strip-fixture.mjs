// Analytic TIFF: 3x3 RGB8, two strips (2 rows + 1 row), EPSG:4326, nodata 255.
// Explicit tags keep the expected bytes independent of the TIFF decoder/writer.
export function multibandStripTiff() {
  const bytes=new Uint8Array(223),v=new DataView(bytes.buffer);
  bytes.set([73,73,42,0]);v.setUint32(4,8,true);v.setUint16(8,12,true);
  const tags=[[256,4,1,3],[257,4,1,3],[258,3,3,158],[259,3,1,1],[262,3,1,2],[273,4,2,164],[277,3,1,3],[278,4,1,2],[279,4,2,172],[284,3,1,1],[34735,3,8,180],[42113,2,4,0x00353532]];
  tags.forEach(([id,type,count,value],i)=>{const at=10+i*12;v.setUint16(at,id,true);v.setUint16(at+2,type,true);v.setUint32(at+4,count,true);v.setUint32(at+8,value,true);});
  [8,8,8].forEach((n,i)=>v.setUint16(158+i*2,n,true));
  [196,214].forEach((n,i)=>v.setUint32(164+i*4,n,true));
  [18,9].forEach((n,i)=>v.setUint32(172+i*4,n,true));
  [1,1,0,1,2048,0,1,4326].forEach((n,i)=>v.setUint16(180+i*2,n,true));
  for(let i=0;i<9;i++)bytes.set([i+1,i+91,i+191],196+i*3);
  return bytes;
}
