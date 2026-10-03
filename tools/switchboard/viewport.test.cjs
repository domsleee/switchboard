const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../../zellij-client/assets/app.js','utf8');
function harness(viewport){
  const sent=[],context={window:{__zjViewport:viewport},lastSentCellDimensions:null,getCellPixelDimensions:()=>({width:8,height:16})};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function getMobileRenderSizing()'),source.indexOf('function initWebSockets(')),context);
  return {context,sent,socket:{send:message=>sent.push(JSON.parse(message).payload)}};
}
test('virtual canvas sizes never overwrite the reported physical viewport',()=>{
  let changed=true;
  const h=harness({getSizing:()=>({pinned:true,cols:200,rows:60}),dimensions:()=>({cols:80,rows:24}),report:()=>{const result=changed;changed=false;return result;}});
  h.context.sendSizeUpdate(h.socket,'client',{},60,200);
  assert.deepEqual(h.sent[0],{type:'TerminalResize',rows:24,cols:80});
  assert.equal(h.sent[1].text_area_pixel_width,640);
  assert.equal(h.sent[1].text_area_pixel_height,384);
  h.context.sendSizeUpdate(h.socket,'client',{},60,200);assert.equal(h.sent.length,2);
  h.context.sendSizeUpdate(h.socket,'client',{},60,200,true);assert.equal(h.sent.length,3);
  assert.deepEqual(h.sent[2],h.sent[0]);
});
test('ordinary native browsers retain mobile sizing without a Switchboard viewport',()=>{
  const h=harness();h.context.window.__zjMobileUi={getRenderSizing:()=>({pinned:true,rows:40,cols:120})};
  assert.equal(h.context.getMobileRenderSizing().cols,120);
  h.context.sendSizeUpdate(h.socket,'client',{},24,80);
  assert.equal(h.sent[0].cols,80);
});
