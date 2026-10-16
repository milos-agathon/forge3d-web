import { cartographicError, finite, integer, type CartographicColor } from './cartography-common.js';
export type PositionAnchor = 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
export class BBox {
  constructor(readonly west: number, readonly south: number, readonly east: number, readonly north: number, readonly crs = 'EPSG:4326') {
    [west, south, east, north].forEach(v => finite(v, 'bbox coordinate'));
    if (east <= west || north <= south) cartographicError('BBox must have positive width and height'); Object.freeze(this);
  }
  get width(): number { return this.east - this.west; }
  get height(): number { return this.north - this.south; }
  get centerLat(): number { return (this.north + this.south) / 2; }
}
export class PlateRegion {
  constructor(readonly x0: number, readonly y0: number, readonly x1: number, readonly y1: number) { [x0, y0, x1, y1].forEach(v => finite(v, 'region coordinate')); Object.freeze(this); }
  get width(): number { return this.x1 - this.x0; }
  get height(): number { return this.y1 - this.y0; }
  get rect(): [number, number, number, number] { return [this.x0, this.y0, this.x1, this.y1]; }
}
/** Native floor-centered anchors, with explicit padding in pixels. */
export function positionPlateElement(size: readonly [number, number], anchor: PositionAnchor, region: PlateRegion, margin = 10): [number, number] {
  size.forEach(v => finite(v, 'element dimension', 0)); finite(margin, 'element margin', 0);
  const [w, h] = size, cx = region.x0 + Math.floor((region.width - w) / 2), cy = region.y0 + Math.floor((region.height - h) / 2);
  switch (anchor) {
    case 'top': return [cx, region.y0 + margin]; case 'bottom': return [cx, region.y1 - h - margin];
    case 'left': return [region.x0 + margin, cy]; case 'right': return [region.x1 - w - margin, cy];
    case 'top-left': return [region.x0 + margin, region.y0 + margin]; case 'top-right': return [region.x1 - w - margin, region.y0 + margin];
    case 'bottom-left': return [region.x0 + margin, region.y1 - h - margin]; case 'bottom-right': return [region.x1 - w - margin, region.y1 - h - margin];
    case 'center': return [cx, cy]; default: cartographicError('Unknown plate anchor');
  }
}
export interface MapPlateConfig {
  width?: number; height?: number; margin?: readonly [number, number, number, number]; background?: CartographicColor; dpi?: number; maxBytes?: number;
}
export interface PlateLayout { mapRegion: PlateRegion; mapImage: PlateRegion | null; elements: { kind: string; rect: PlateRegion }[] }
export function fitPlateImage(width: number, height: number, region: PlateRegion): PlateRegion {
  integer(width, 'image width'); integer(height, 'image height');
  const scale = Math.min(region.width / width, region.height / height), w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  const x = region.x0 + Math.floor((region.width - w) / 2), y = region.y0 + Math.floor((region.height - h) / 2);
  return new PlateRegion(x, y, x + w, y + h);
}
