const api = location.search.includes('source') ? await import('/src-ts/index.ts') : await import('../dist/index.js');
const registry = new api.CodecRegistry();
const status = document.querySelector('#status');
status.textContent = JSON.stringify(registry.capabilities(), null, 2);
window.__w22 = { api, registry, ready: true };
addEventListener('pagehide', () => { void registry.dispose(); }, { once:true });
