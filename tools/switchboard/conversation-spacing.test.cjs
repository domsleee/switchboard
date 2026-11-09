const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

const fixture=`<div class="conversation-panel"><div class="conversation-messages">
 <div class="conversation-message assistant" id="first"><p id="intro">Three things limit that result:</p><ul id="list"><li>One track.</li><li>Slow start.</li></ul><p id="next">The next test.</p><p id="last">Do you want it queued?</p></div>
 <div class="conversation-message user" id="reply">Is it running?</div>
</div></div>`;

test('Conversation spaces blocks and messages like T3 Code',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  for(const [viewport,bodySize] of [[{width:1280,height:900},'14px'],[{width:390,height:844},'16px']]){
   const page=await browser.newPage({viewport});
   await page.setContent(fixture);await page.addStyleTag({path:path.join(__dirname,'static','conversation.css')});
   const gap=(above,below)=>page.evaluate(([a,b])=>{const box=id=>document.getElementById(id).getBoundingClientRect();return Math.round((box(b).top-box(a).bottom)*10)/10;},[above,below]);
   assert.equal(await gap('next','last'),10.4,'Between paragraphs');
   assert.equal(await gap('intro','list'),10.4,'Before a list');
   assert.equal(await gap('list','next'),10.4,'After a list');
   assert.equal(await gap('first','reply'),16,'Between messages');
   assert.equal(await page.locator('#next').evaluate(node=>getComputedStyle(node).fontSize),bodySize);
   await page.close();
  }
 }finally{await browser.close();}
});

test('Conversation tables keep words whole and read from the left',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:760,height:600}});
  const long='Reproduced on a real session. The new test failed before the fix, and every integrated Conversation test passes with it, including the slow ones.';
  await page.setContent(`<div class="conversation-panel"><div class="conversation-messages"><div class="conversation-message assistant"><div class="conversation-table"><table><tr><td id="label">Review</td><td id="value">${long} <code id="code">gpt-6.1-sol</code></td></tr></table></div></div></div></div>`);
  await page.addStyleTag({path:path.join(__dirname,'static','conversation.css')});
  const lines=id=>page.evaluate(id=>{const range=document.createRange();range.selectNodeContents(document.getElementById(id));return new Set([...range.getClientRects()].map(rect=>Math.round(rect.top))).size;},id);
  assert.equal(await lines('label'),1,'A short label stays on one line');
  assert.equal(await lines('code'),1,'Inline code stays whole');
  assert.equal(await page.locator('#value').evaluate(node=>getComputedStyle(node).textAlign),'start');
 }finally{await browser.close();}
});
