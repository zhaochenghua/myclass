const { chromium } = require('playwright');
const { startTestServer } = require('../server/testSupport');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function pdf() {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>'];
 let data='%PDF-1.4\n', offsets=[0]; objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${s}\nendobj\n`});const pos=Buffer.byteLength(data); data+=`xref\n0 5\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;return data;
}
(async()=>{
 const server=await startTestServer({withWeb:true});const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const viewer=await browser.newPage({viewport:{width:1280,height:800},hasTouch:true});const errors=[];viewer.on('pageerror',e=>errors.push(e.message));
  await viewer.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
  await viewer.goto(server.base+'/');await viewer.waitForFunction(()=>!!state.roomCode);
  async function upload(bytes,name,type){const form=new FormData();form.append('file',new Blob([bytes],{type}),name);const r=await fetch(server.base+'/api/courseware',{method:'POST',headers:{Authorization:'Bearer alice-test-token'},body:form});assert.equal(r.status,200);return r.json();}
  const image=await upload(Buffer.from(await viewer.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=600;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,1000,600);return c.toDataURL('image/png').split(',')[1]}),'base64'),'picture.png','image/png');
  const document=await upload(pdf(),'lesson.pdf','application/pdf');
  const open=async item=>{await viewer.evaluate(item=>{state.teacherToken='alice-test-token';openDirectCourseware(item)},item);await viewer.waitForFunction(()=>state.presentationMode==='courseware');await viewer.waitForTimeout(200);};
  const cdp=await viewer.context().newCDPSession(viewer);
  async function touch(type,touchPoints){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints});await viewer.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
  async function pinch(){
   const count=await viewer.evaluate(()=>state.annotations.strokes.length);
   await touch('touchStart',[{id:1,x:450,y:350}]);
   await touch('touchMove',[{id:1,x:470,y:370}]);
   await touch('touchStart',[{id:1,x:470,y:370},{id:2,x:700,y:370}]);
   await touch('touchMove',[{id:1,x:440,y:370},{id:2,x:730,y:370}]);
   await touch('touchMove',[{id:1,x:410,y:370},{id:2,x:760,y:370}]);
   await touch('touchEnd',[]);
   assert.equal(await viewer.evaluate(()=>state.annotations.strokes.length),count,'pinch must not leave a stroke');
  }
  async function draw(){const box=await viewer.locator('#annotationCanvas').boundingBox();await viewer.mouse.move(box.x+box.width*.35,box.y+box.height*.4);await viewer.mouse.down();await viewer.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:10});await viewer.mouse.up();await viewer.waitForTimeout(250);await viewer.screenshot({path:path.join(os.tmpdir(),'myclass-notes-debug.png')});}
  await open(image);await viewer.waitForFunction(()=>elements.coursewareImage.naturalWidth>0);await draw();assert.equal(await viewer.evaluate(()=>state.annotations.strokes.length),1);
  await pinch();
  await viewer.evaluate(()=>closeCourseware());await open(image);await viewer.waitForFunction(()=>state.annotations.strokes.length===1);assert.equal(await viewer.evaluate(()=>strokesForCurrentPage().length),1);
  await viewer.evaluate(()=>zoomImageViewAt(2));const scale=await viewer.evaluate(()=>state.imageView.scale);
  await viewer.evaluate(()=>state.socket.close());await viewer.waitForFunction(()=>state.socket?.readyState===1);await viewer.waitForTimeout(400);assert.equal(await viewer.evaluate(()=>state.imageView.scale),scale);assert.equal(await viewer.evaluate(()=>state.annotations.strokes.length),1);
  await viewer.screenshot({path:path.join(os.tmpdir(),'myclass-notes-image.png')});
  await viewer.evaluate(()=>clearAnnotations());await viewer.waitForTimeout(200);await viewer.evaluate(()=>closeCourseware());await open(image);assert.equal(await viewer.evaluate(()=>state.annotations.strokes.length),0);
  await open(document);await viewer.waitForFunction(()=>state.courseware?.pdfDocument && state.courseware.pageCount===2);await draw();
  await viewer.evaluate(()=>showCoursewarePage(2));await viewer.waitForTimeout(250);await draw();assert.equal(await viewer.evaluate(()=>state.annotations.strokes.length),2);
  await viewer.evaluate(()=>closeCourseware());await open(document);await viewer.waitForFunction(()=>state.courseware?.pdfDocument && state.annotations.strokes.length===2);assert.equal(await viewer.evaluate(()=>strokesForCurrentPage().length),1);
  await viewer.evaluate(()=>clearAnnotations());await viewer.waitForTimeout(200);await viewer.evaluate(()=>showCoursewarePage(2));await viewer.waitForTimeout(200);assert.equal(await viewer.evaluate(()=>strokesForCurrentPage().length),1);
  await viewer.screenshot({path:path.join(os.tmpdir(),'myclass-notes-pdf.png')});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  phone.on('pageerror',e=>errors.push(e.message));
  await phone.addInitScript(()=>{localStorage.setItem('myclass.ios.token',JSON.stringify('alice-test-token'));localStorage.setItem('myclass.ios.username',JSON.stringify('alice_test'));});
  await phone.route('**/ios/js/app.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text())+'\nglobalThis.notesTest={state, connectToRoom, switchToReadyMediaItem};'});});
  await phone.goto(server.base+'/ios/');await phone.waitForFunction(()=>!!globalThis.notesTest && notesTest.state.token === 'alice-test-token' && notesTest.state.screen === 'Connect');
  const code=await viewer.evaluate(()=>state.roomCode);await phone.evaluate(code=>notesTest.connectToRoom(code),code);await phone.waitForFunction(()=>notesTest.state.joined);
  await phone.evaluate(item=>{const t=notesTest;t.state.media.queue=[{...item,kind:'image',status:'ready',name:'picture',scale:1,panX:0,panY:0,rotation:0}];t.switchToReadyMediaItem(0);},image);
  await viewer.waitForFunction(()=>!elements.imagePlayerOverlay.hidden && elements.coursewareImage.naturalWidth>0);await viewer.waitForTimeout(300);await draw();await phone.waitForFunction(()=>notesTest.state.mediaBoard.count===1);
  await pinch();await phone.waitForTimeout(150);assert.equal(await phone.evaluate(()=>notesTest.state.mediaBoard.count),1,'phone must not receive pinch trial ink');
  await phone.evaluate(()=>notesTest.switchToReadyMediaItem(0));await phone.waitForTimeout(500);await phone.waitForFunction(()=>notesTest.state.mediaBoard.count===1);await viewer.waitForFunction(()=>state.annotations.strokes.length===1);
  await phone.evaluate(()=>notesTest.state.mediaBoard.clear());await viewer.waitForFunction(()=>state.annotations.strokes.length===0);
  await phone.evaluate(()=>notesTest.switchToReadyMediaItem(0));await phone.waitForTimeout(250);assert.equal(await phone.evaluate(()=>notesTest.state.mediaBoard.count),0);
  await phone.screenshot({path:path.join(os.tmpdir(),'myclass-notes-ios.png')});
  assert.deepEqual(errors,[]);console.log('PASS: actual viewer drawing, pinch without trial ink on viewer/phone/reopen, image reopen/clear, reconnect zoom+ink, PDF page isolation and reopen, iOS restore and clear');
 } finally {await browser.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});

