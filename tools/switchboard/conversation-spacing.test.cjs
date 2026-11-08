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
