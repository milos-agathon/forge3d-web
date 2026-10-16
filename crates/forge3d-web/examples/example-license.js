// Explicit input for Pro workflows in browser examples. Nothing is loaded from a server.
export async function exampleLicense(api) {
  const input=document.createElement('input');input.type='password';input.placeholder='F3D Pro license key';input.setAttribute('aria-label','Pro license key');
  const button=document.createElement('button');button.textContent='Apply license';const status=document.createElement('span');status.setAttribute('role','status');
  document.body.prepend(input,button,status);
  button.onclick=async()=>{try{await api.setLicenseKey(input.value);status.textContent=api.getLicenseInfo().status;}catch(error){status.textContent=error.message;}};
  const key=sessionStorage.getItem('forge3d-example-license');
  if(key)await api.setLicenseKey(key);
}
