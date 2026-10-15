/** Literal asset URLs are required for Vite/Rollup/Webpack asset rewriting. */
export function cartographicFontSources(): { family: string; weight: string; url: URL }[] {
  return [
    { family: 'DejaVu Sans', weight: '400', url: new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url) },
    { family: 'DejaVu Sans', weight: '700', url: new URL('../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url) },
    { family: 'NotoSans', weight: '400', url: new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url) },
    { family: 'NotoSansArabic', weight: '400', url: new URL('../assets/fonts/NotoSansArabic-Regular.ttf', import.meta.url) },
    { family: 'NotoSansDevanagari', weight: '400', url: new URL('../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url) },
  ];
}
export function exportFontSource(family: string): URL | undefined {
  return cartographicFontSources().find(f => f.family === family && f.weight === '400')?.url;
}
