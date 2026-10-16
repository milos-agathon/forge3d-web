import { createWorkflows } from './workflows.js';
import { exampleLicense } from '../example-license.js';
const source = new URLSearchParams(location.search).has('source');
const api = await (source ? import('../../src-ts/index.ts') : import('../../dist/index.js'));
await exampleLicense(api);
const response = await fetch(new URL('./catalog.json', import.meta.url));
if (!response.ok) throw Error('Migration catalog unavailable');
const catalog = await response.json(), select = document.querySelector('#example'), status = document.querySelector('#status');
for (const entry of catalog) { const option = document.createElement('option'); option.value = entry.name; option.textContent = entry.nativePath; select.append(option); }
select.value = new URLSearchParams(location.search).get('example') ?? 'all';
let controller;
const urls = new Set();
function clearDownloads() { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); document.querySelector('#downloads').replaceChildren(); }
async function run(name = select.value) {
  if (controller) throw Error('A workflow run is already active');
  clearDownloads();
  controller = new AbortController(); document.querySelector('#cancel').disabled = false; document.querySelector('#run').disabled = true;
  const selected = name === 'all' ? catalog : catalog.filter(e => e.name === name);
  const results = {}, artifacts = [];
  let activeWorkflow;
  const workflows = createWorkflows(api, document.querySelector('canvas'), controller.signal, (blob, name) => {
    if (controller.signal.aborted) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a'); urls.add(url);
    link.href = url; link.download = `${activeWorkflow}-${name}`; link.textContent = link.download; link.style.marginRight = '12px';
    document.querySelector('#downloads').append(link); artifacts.push({ name: link.download, bytes: blob.size, type: blob.type });
  });
  try {
    if (!selected.length) throw Error('Unknown native example');
    for (const workflow of new Set(selected.flatMap(e => e.workflows))) {
      controller.signal.throwIfAborted(); status.textContent = `Running ${workflow}…`;
      activeWorkflow = workflow;
      results[workflow] = await workflows[workflow]();
    }
    const report = { workflows: results, artifacts, examples: selected.map(e => ({ name: e.name, workflows: e.workflows, source: e.source, status: 'executed' })) };
    status.textContent = JSON.stringify(report, null, 2); window.__w23.report = report; return report;
  } finally { controller = undefined; document.querySelector('#cancel').disabled = true; document.querySelector('#run').disabled = false; }
}
document.querySelector('#run').onclick = () => run().catch(error => { status.textContent = `${error.code ?? error.name}: ${error.message}`; });
document.querySelector('#cancel').onclick = () => controller?.abort();
window.__w23 = { ready: true, run, api, catalog };
status.textContent = 'Ready. Choose an original example or run all workflows.';
addEventListener('pagehide', () => { controller?.abort(); clearDownloads(); });
