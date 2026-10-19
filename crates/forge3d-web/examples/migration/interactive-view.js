// The view owns its listeners. Rendering is coalesced and cancellation belongs
// to the gallery run, so changing examples cannot publish a stale frame.
export function attachOrbitInput(canvas, controller, draw, signal) {
  const events=new AbortController();let closed=false,drag=null,dirty=false,running=false,renders=0,error=null;
  canvas.tabIndex=0;canvas.dataset.workflowViewer='true';
  async function request(){
    dirty=true;if(running)return;running=true;
    try{while(dirty&&!closed&&!signal.aborted){dirty=false;await draw(controller.getCamera());renders++;}}
    catch(reason){if(!closed&&!signal.aborted){error=String(reason.message??reason);canvas.dispatchEvent(new CustomEvent('forge3d-view-error',{detail:error}));}}
    finally{running=false;}
  }
  canvas.addEventListener('pointerdown',event=>{drag=[event.clientX,event.clientY];canvas.focus();canvas.setPointerCapture(event.pointerId);},{signal:events.signal});
  canvas.addEventListener('pointermove',event=>{if(!drag)return;controller.orbitBy((event.clientX-drag[0])*.4,(event.clientY-drag[1])*.4);drag=[event.clientX,event.clientY];void request();},{signal:events.signal});
  canvas.addEventListener('pointerup',()=>{drag=null;},{signal:events.signal});
  canvas.addEventListener('pointercancel',()=>{drag=null;},{signal:events.signal});
  canvas.addEventListener('wheel',event=>{event.preventDefault();controller.zoomBy(event.deltaY);void request();},{signal:events.signal,passive:false});
  canvas.addEventListener('keydown',event=>{const d={ArrowLeft:[-5,0],ArrowRight:[5,0],ArrowUp:[0,-5],ArrowDown:[0,5]}[event.key];if(d){event.preventDefault();controller.orbitBy(...d);void request();}},{signal:events.signal});
  function dispose(){closed=true;events.abort();canvas.removeAttribute('data-workflow-viewer');signal.removeEventListener('abort',dispose);}
  signal.addEventListener('abort',dispose,{once:true});
  return {dispose,inspect:()=>({view:controller.getView(),pending:running||dirty,renders,error,disposed:closed})};
}
