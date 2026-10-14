const { chromium } = require('playwright');
const { startTestServer } = require('../server/testSupport');
const { zip, fixtureFiles } = require('../server/testFixtures/pptxVideoFixture');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function pdf() {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>'];
 let data='%PDF-1.4\n', offsets=[0]; objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${s}\nendobj\n`});const pos=Buffer.byteLength(data); data+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;return data;
}
(async()=>{
 const server=await startTestServer({withWeb:true});const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const viewer=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];viewer.on('pageerror',e=>errors.push(e.message));
  await viewer.addInitScript(()=>{Element.prototype.requestFullscreen=async()=>{}});
  await viewer.goto(server.base+'/');await viewer.waitForFunction(()=>!!state.roomCode);
  const base64=await viewer.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let n=0;
    const draw=()=>{x.fillStyle='#143e55';x.fillRect(0,0,640,360);x.fillStyle='white';x.font='36px sans-serif';x.fillText('PPTX embedded video '+n++,40,190)};draw();
    const stream=c.captureStream(15),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
    recorder.ondataavailable=e=>chunks.push(e.data);const done=new Promise(r=>recorder.onstop=r);recorder.start();const timer=setInterval(draw,66);await new Promise(r=>setTimeout(r,2200));recorder.stop();await done;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
    return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}))});
  });
  const root=path.join(server.directory,'courseware');const item={id:'embedded',userId:'alice',url:'/myclass/public/courseware/embedded.pdf',originalUrl:'/myclass/public/courseware/embedded.pptx',title:'内嵌视频测试',conversion:{slideCount:2,statePages:[1,2]}};
  const files=fixtureFiles(Buffer.from(base64,'base64'),'webm');
  files['ppt/slides/slide2.xml']=files['ppt/slides/slide2.xml'].replace('</p:spTree>','<p:extLst><a:videoFile r:link="other"/></p:extLst></p:spTree>');
  files['ppt/slides/_rels/slide2.xml.rels']=files['ppt/slides/_rels/slide2.xml.rels'].replace('</Relationships>','<Relationship Id="other" Target="../media/other.webm" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"/></Relationships>');
  files['ppt/media/other.webm']=files['ppt/media/lesson.webm'];
  await fs.writeFile(path.join(root,'embedded.pptx'),zip(files));await fs.writeFile(path.join(root,'embedded.pdf'),pdf());await fs.writeFile(path.join(root,'index.json'),JSON.stringify([item]));
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});phone.on('pageerror',e=>errors.push(e.message));
  await phone.addInitScript(()=>{localStorage.setItem('myclass.ios.token',JSON.stringify('alice-test-token'));localStorage.setItem('myclass.ios.username',JSON.stringify('alice_test'));});
  await phone.goto(server.base+'/ios/');await phone.locator('#connectButton').waitFor({state:'visible'});const code=await viewer.evaluate(()=>state.roomCode);await phone.locator('#roomCodeInput').fill(code);await phone.locator('#connectButton').click();await phone.waitForFunction(()=>window.__myclassApp.joined);
  await viewer.evaluate(item=>{state.teacherToken='alice-test-token';openDirectCourseware(item)},item);
  await viewer.waitForFunction(()=>!!state.courseware?.pdfDocument);await viewer.locator('.embedded-launch').waitFor({state:'visible'});await phone.locator('.embedded-launch').waitFor({state:'visible'});
  const box=await viewer.locator('#annotationCanvas').boundingBox();await viewer.mouse.move(box.width*.3,box.height*.3);await viewer.mouse.down();await viewer.mouse.move(box.width*.6,box.height*.6,{steps:8});await viewer.mouse.up();await viewer.waitForTimeout(250);
  await viewer.evaluate(()=>{state.courseware.scale=1.8;updateCoursewareCanvasPlacement()});
  const launchVideo=async page=>{await page.locator('.embedded-launch').click();await page.getByRole('button',{name:'第 1 页视频 1',exact:true}).click()};
  const snapshot=()=>viewer.evaluate(()=>JSON.stringify({page:state.courseware.page,scale:state.courseware.scale,strokes:state.annotations.strokes}));const before=await snapshot();
  await launchVideo(viewer);await viewer.waitForFunction(()=>document.querySelector('.embedded-card video').currentTime>0.1);await viewer.locator('.embedded-card video').evaluate(v=>v.pause());
  await viewer.screenshot({path:path.join(os.tmpdir(),'myclass-embedded-video.png')});await viewer.locator('.embedded-close').click();assert.equal(await snapshot(),before);
  await launchVideo(phone);await viewer.locator('.embedded-overlay').waitFor({state:'visible'});await phone.getByRole('button',{name:'暂停',exact:true}).click();await viewer.waitForFunction(()=>document.querySelector('.embedded-card video').paused);await phone.screenshot({path:path.join(os.tmpdir(),'myclass-embedded-ios.png')});await phone.locator('.embedded-close').click();await viewer.locator('.embedded-overlay').waitFor({state:'hidden'});assert.equal(await snapshot(),before);
  await launchVideo(viewer);await viewer.locator('.embedded-card video').evaluate(v=>v.dispatchEvent(new Event('ended')));await viewer.locator('.embedded-overlay').waitFor({state:'hidden'});assert.equal(await snapshot(),before);
  await viewer.locator('.embedded-card video').evaluate(v=>{v.play=()=>Promise.reject(new DOMException('blocked','NotAllowedError'))});
  await launchVideo(viewer);await viewer.getByText('请点击视频上的播放按钮开始播放。',{exact:true}).waitFor();
  await viewer.locator('.embedded-card video').evaluate(v=>v.dispatchEvent(new Event('error')));await viewer.getByText(/视频暂时无法播放/).waitFor();await viewer.locator('.embedded-close').click();
  await viewer.waitForTimeout(2000);await viewer.evaluate(()=>showCoursewarePage(2));await viewer.locator('.embedded-launch').waitFor({state:'hidden'});await phone.locator('.embedded-launch').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log('PASS: real extracted video decoding, in-slide launch, return preserves zoom/page/ink, iOS remote open/pause/close, ended returns, page association');
 } finally {await browser.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
