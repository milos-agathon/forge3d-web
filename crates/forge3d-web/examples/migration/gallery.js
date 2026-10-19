import { createWorkflows } from './workflows.js';
import { executeGuideExamples } from './guide-examples.js';
import { verifyMigrationInputs } from './integrity.js';
import { exampleLicense } from '../example-license.js';
const source = new URLSearchParams(location.search).has('source');
const api = await (source ? import('../../src-ts/index.ts') : import('../../dist/index.js'));
const integrity=await verifyMigrationInputs();
await exampleLicense(api);
const response = await fetch(new URL('./catalog.json', import.meta.url));
if (!response.ok) throw Error('Migration catalog unavailable');
const catalog = await response.json(), select = document.querySelector('#example'), status = document.querySelector('#status');
for (const entry of catalog) { const option = document.createElement('option'); option.value = entry.name; option.textContent = entry.nativePath; select.append(option); }
select.value = new URLSearchParams(location.search).get('example') ?? 'all';
let controller;
let retainedController,activeViewer;
const viewers=new Set();
function clearViewers(){for(const owner of viewers)owner.dispose();viewers.clear();retainedController?.abort();retainedController=undefined;activeViewer=undefined;}
const urls = new Set();
function clearDownloads() { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); document.querySelector('#downloads').replaceChildren(); }
async function run(name = select.value) {
  if (controller) throw Error('A workflow run is already active');
  clearViewers();
  clearDownloads();
  controller = new AbortController(); document.querySelector('#cancel').disabled = false; document.querySelector('#run').disabled = true;
  const runController=controller;
  const selected = name === 'all' ? catalog : catalog.filter(e => e.name === name);
  const results = {}, artifacts = [];
  let activeWorkflow;
  const output = (blob, name) => {
    if (runController.signal.aborted) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a'); urls.add(url);
    link.href = url; link.download = `${activeWorkflow}-${name}`; link.textContent = link.download; link.style.marginRight = '12px';
    document.querySelector('#downloads').append(link); artifacts.push({ name: link.download, bytes: blob.size, type: blob.type });
  };
  try {
    if (!selected.length) throw Error('Unknown native example');
    const examples=[];
    for (const entry of selected) {
      const workflows=createWorkflows(api,document.querySelector('canvas'),runController.signal,output,{...entry,interactive:name!=='all'},owner=>{viewers.add(owner);retainedController=runController;activeViewer=owner.inspect;}), steps=[];
      let execution='executed';
      try {
        for(const workflow of entry.workflows) {
          controller.signal.throwIfAborted();status.textContent=`Running ${entry.name}: ${workflow}…`;activeWorkflow=entry.name+'-'+workflow;
          const result=await workflows[workflow]();steps.push({workflow,result});results[workflow]??=result;
          if(result.status==='unavailable'){execution='unavailable';break;}
        }
      } catch(error) {
        if(error.code!=='LICENSE_REQUIRED')throw error;
        execution='blocked-license';steps.push({workflow:activeWorkflow,error:{code:error.code,message:error.message}});
      }
      examples.push({name:entry.name,workflows:entry.workflows,source:entry.source,status:execution,steps});
    }
    const report = { workflows: results, artifacts, examples };
    status.textContent = JSON.stringify(report, null, 2); window.__w23.report = report; return report;
  } finally { controller = undefined; document.querySelector('#cancel').disabled = true; document.querySelector('#run').disabled = false; }
}
document.querySelector('#run').onclick = () => run().catch(error => { status.textContent = `${error.code ?? error.name}: ${error.message}`; });
document.querySelector('#cancel').onclick = () => controller?.abort();
window.__w23 = { ready: true, run, api, catalog, integrity, createWorkflows, inspectViewer:()=>activeViewer?.()??null,retainedViewers:()=>viewers.size, verifyGuideExamples:async()=>{
  const surface=document.createElement('canvas');
  try{return await executeGuideExamples(api,surface);}finally{surface.remove();}
} };
status.textContent = 'Ready. Choose an original example or run all workflows.';
document.querySelector('canvas').addEventListener('forge3d-view-error',event=>{status.textContent='Viewer: '+event.detail;});
addEventListener('pagehide', () => { controller?.abort();clearViewers(); clearDownloads(); });
