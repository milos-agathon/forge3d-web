import { deflateSync } from 'node:zlib';
function chunk(name, bytes) {
  const content = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const out = Buffer.alloc(content.length + 8); out.writeUInt32BE(bytes.length); content.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png(width, height, depth, type, raw, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([depth, type, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function browserPngCompatibilityFixtures() {
  return [
    { name: 'trailing bytes after IEND', width: 1, height: 1, pixel: [12,34,56,255], bytes: Buffer.concat([png(1,1,8,6,Buffer.from([0,12,34,56,255])),Buffer.from([1,2,3])]) },
    { name: 'tRNS longer than PLTE', width: 1, height: 1, pixel: [0,0,0,255], bytes: png(1,1,1,3,Buffer.from([0,0]),[chunk('PLTE',Buffer.from([0,0,0])),chunk('tRNS',Buffer.from([255,0]))]) },
    { name: '4097x4097 1-bit PNG', width: 4097, height: 4097, pixel: [0,0,0,255], bytes: png(4097,4097,1,0,Buffer.alloc((1+Math.ceil(4097/8))*4097)) },
  ];
}
