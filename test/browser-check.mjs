import {writeFileSync,readFileSync,existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const projectDir=fileURLToPath(new URL('../',import.meta.url));
import assert from 'node:assert/strict';
const downloadDir=mkdtempSync(join(tmpdir(),'hwp-browser-download-'));
const targets=await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let sequence=0;const pending=new Map();const exceptions=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{})};
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));})}
async function evalJS(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function waitFor(expression){await evalJS(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const poll=()=>{if(${expression})resolve(true);else if(Date.now()>end)reject(new Error('UI timeout'));else setTimeout(poll,100)};poll()})`)}
await call('Runtime.enable');await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
await call('Page.navigate',{url:process.argv[2] || 'http://127.0.0.1:8765/'});
await waitFor("document.querySelector('#file') && document.querySelector('#status') && document.readyState === 'complete'");
await new Promise(resolve=>setTimeout(resolve,300));

const root=await call('DOM.getDocument');
const {nodeId}=await call('DOM.querySelector',{nodeId:root.root.nodeId,selector:'#file'});
// Chromium은 --remote-debugging-port=9222로 먼저 실행합니다.
// 선택 인수: 사이트 URL, 기존 샘플 폴더. 생략하면 공개 샘플을 임시 폴더에 받습니다.
const sampleDir=process.argv[3] ? resolve(process.argv[3])+'/' : mkdtempSync(join(tmpdir(),'hwp-browser-samples-'))+'/';
if(!process.argv[3]) {
 const base='https://raw.githubusercontent.com/edwardkim/rhwp/f1f9c6ae58344ee9368996d3543f76b9345cf227/';
 const paths=['samples/equation-lim.hwp','samples/shape-001.hwp','samples/chart/세로막대형/묶은세로막대형.hwp','samples/pic-in-table-01.hwp','samples/pic-in-head-01.hwp','samples/pic2.hwpx','samples/issue5720/2734559_mixed_column_grid.hwpx','fuzz/corpus/parse_hml/formatting_table.hml','samples/hwp3-sample.hwp','samples/footnote-01.hwp','samples/table_scattered_header_rowbreak.hwp','samples/HWP3-password-123456.hwp','samples/HWP5-password-123456.hwpx','samples/hwp3-sample16-hwp5-2024-password-123456.hwp'];
 for(const path of paths){const r=await fetch(base+path);assert.ok(r.ok,path);writeFileSync(sampleDir+path.split('/').at(-1),new Uint8Array(await r.arrayBuffer()));}
 const r=await fetch('https://raw.githubusercontent.com/sihoo7005/hwp/8abd96e7b1f99b4256f605b6a7777b6e03b1ca11/hwp%20file%20for%20test.hwp');assert.ok(r.ok);writeFileSync(sampleDir+'plain.hwp',new Uint8Array(await r.arrayBuffer()));
}

async function select(path){
 await call('DOM.setFileInputFiles',{nodeId,files:[path]});
 await waitFor("document.querySelector('.page-image')?.naturalWidth > 0 || !document.querySelector('#password-form').hidden || document.querySelector('#status').dataset.error === 'true'");
 return await evalJS("document.querySelector('#viewer-status').textContent || document.querySelector('#status').textContent");
}
async function svg(){return await evalJS("fetch(document.querySelector('.page-image').src).then(r=>r.text())")}
async function svgText(){return await evalJS("fetch(document.querySelector('.page-image').src).then(r=>r.text()).then(s=>new DOMParser().parseFromString(s,'image/svg+xml').documentElement.textContent.replace(/\\n/g,''))")}
async function settled(){await waitFor("document.querySelector('#preview').dataset.pending === 'false' && document.querySelector('.page-image')?.naturalWidth > 0 && document.querySelector('.page-image').dataset.revision === document.querySelector('#preview').dataset.revision && Number(document.querySelector('.page-image').dataset.page) + 1 === Number(document.querySelector('#page-number').value)")}
async function mode(value){await evalJS(`document.querySelector('#view-mode').value=${JSON.stringify(value)};document.querySelector('#view-mode').dispatchEvent(new Event('change'))`);if(value==='document')await settled();else await waitFor("document.querySelector('.engine-text') !== null")}
async function linePoint(index=0,offset=3){return await evalJS(`fetch(document.querySelector('.page-image').src).then(r=>r.text()).then(s=>{const svg=new DOMParser().parseFromString(s,'image/svg+xml');const lines=[...svg.querySelectorAll('text')].filter((t,i,a)=>a.findIndex(v=>Math.round(Number(v.getAttribute('y'))*10)===Math.round(Number(t.getAttribute('y'))*10))===i);const t=lines[${index}],image=document.querySelector('.page-image'),b=image.getBoundingClientRect(),scale=b.width/Number(image.dataset.width);return {x:b.left+(Number(t.getAttribute('x'))+${offset})*scale,y:b.top+(Number(t.getAttribute('y'))-5)*scale}})`)}
async function clickLine(index=0){const point=await linePoint(index);await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await waitFor("document.activeElement.id === 'document-input'");return point}
assert.match(await select(sampleDir+'plain.hwp'),/HWP · 1쪽/);await settled();
assert.equal(await evalJS("document.querySelector('#view-mode').value"),'document');
assert.equal(await evalJS("document.querySelector('#text-editor')"),null,'no separate paragraph form');
await clickLine();assert.equal(await evalJS("document.activeElement.dataset.paragraph"),'0');
assert.ok(await evalJS("document.querySelector('.document-caret') !== null"));
// The same focused input and paper remain mounted throughout typing and rendering.
await evalJS("window.editorInput=document.activeElement;window.editorPaper=document.querySelector('.page-surface')");
const changed='부산광역시😀에서 새 문장을 입력합니다.\n다음 줄도 저장합니다.';
await evalJS(`const field=document.querySelector('#document-input');field.dispatchEvent(new CompositionEvent('compositionstart'));field.value=${JSON.stringify(changed)};field.setSelectionRange(7,7);field.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'광역시'}));`);
await evalJS("new Promise(r=>setTimeout(r,300))");assert.equal(await evalJS("document.querySelector('#preview-state').textContent"),'원본','composition not committed early');
assert.equal(await evalJS("document.querySelector('.composition-text').textContent"),'광역시');
await evalJS("document.querySelector('#document-input').dispatchEvent(new CompositionEvent('compositionend'))");
await waitFor("document.querySelector('#preview-state').textContent === '수정 중'");await settled();
assert.equal(await evalJS("document.activeElement === editorInput && document.querySelector('.page-surface') === editorPaper"),true);
assert.equal(await evalJS("document.activeElement.selectionStart"),7,'caret retained');
assert.equal(await evalJS("document.querySelector('#document-input').value"),changed);
assert.match(await svgText(),/부산광역시/);assert.equal(await evalJS("document.querySelector('#view-mode').value"),'document');
await evalJS("document.querySelector('#undo').click()");await waitFor("document.querySelector('#document-input').value.includes('서울은')");await settled();
assert.equal(await evalJS("document.querySelector('#save').disabled"),true,'undo returns clean initial document');
await evalJS("document.querySelector('#redo').click()");await waitFor("document.querySelector('#document-input').value.includes('부산광역시')");await settled();
await mode('text');assert.match(await evalJS("document.querySelector('#preview').textContent"),/다음 줄도/);await mode('document');
await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
const download=downloadDir+'/plain_수정.hwp';for(let i=0;i<40&&!existsSync(download);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(download));
const {default:init,HwpDocument}=await import(new URL('../node_modules/@rhwp/core/rhwp.js',import.meta.url));
await init({module_or_path:readFileSync(new URL('../node_modules/@rhwp/core/rhwp_bg.wasm',import.meta.url))});
const reopened=new HwpDocument(readFileSync(download));assert.equal(reopened.getTextRange(0,0,0,reopened.getParagraphLength(0,0)),changed);reopened.free();
assert.equal(await evalJS("document.querySelector('#save').disabled"),true);
// Different paragraphs can retain pending edits until an immediate save.
await select(sampleDir+'plain.hwp');await settled();
const points=[await linePoint(1),await linePoint(2)];
await evalJS(`const surface=document.querySelector('.page-surface');for(const [point,text] of ${JSON.stringify([[points[0],'둘째 문단을 새로 씁니다.'],[points[1],'셋째 문단도 변경합니다.']])}){surface.dispatchEvent(new PointerEvent('pointerdown',{...point,clientX:point.x,clientY:point.y,pointerType:'mouse',pointerId:1,button:0}));surface.dispatchEvent(new PointerEvent('pointerup',{pointerId:1}));const f=document.querySelector('#document-input');f.value=text;f.dispatchEvent(new InputEvent('input',{bubbles:true}))}document.querySelector('#save').click()`);
await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작') && document.querySelector('#save').disabled");await settled();
assert.match(await svgText(),/둘째문단/);assert.match(await svgText(),/셋째문단/);
// A real click, drag, clipboard-style input, and keyboard navigation operate on the page.
const point=await clickLine();
await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+60,y:point.y,button:'left',buttons:1});
await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+60,y:point.y,button:'left',clickCount:1});
assert.ok(await evalJS("document.querySelector('#document-input').selectionEnd > document.querySelector('#document-input').selectionStart"));
assert.ok(await evalJS("document.querySelector('.selection-rect') !== null"));
await call('Input.insertText',{text:'직접 입력😀'});await waitFor("document.querySelector('#document-input').value.includes('직접 입력😀')");await settled();assert.match(await svgText(),/직접입력/);
await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown'});
assert.equal(await evalJS("document.activeElement.dataset.paragraph"),'1');
await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
// When a paragraph crosses pages, typing follows its caret and keeps it visible.
const longDoc=new HwpDocument(readFileSync(sampleDir+'plain.hwp'));
const longText=Array.from({length:90},(_,i)=>`${i+1}번째 줄에서 문서 편집을 확인합니다.`).join('\n');
longDoc.replaceText(0,0,0,longDoc.getParagraphLength(0,0),longText);
const longPath=join(downloadDir,'long-body.hwp');writeFileSync(longPath,longDoc.exportHwp());longDoc.free();
await select(longPath);await settled();await clickLine();
await evalJS("{const f=document.querySelector('#document-input');f.setSelectionRange(f.value.length,f.value.length)}");
await call('Input.insertText',{text:' 마지막 입력'});await settled();
assert.ok(Number(await evalJS("document.querySelector('#page-number').value"))>1);
assert.match(await svgText(),/마지막입력/);
assert.equal(await evalJS("document.activeElement.id"),'document-input');
assert.ok(await evalJS("(()=>{const c=document.querySelector('.document-caret').getBoundingClientRect(),p=document.querySelector('#preview').getBoundingClientRect();return c.top>=p.top && c.bottom<=p.bottom})()"));
await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
await evalJS("document.querySelector('#document-input').focus();document.querySelector('#document-input').setSelectionRange(0,0)");
await waitFor("document.querySelector('#page-number').value === '1'");await settled();
assert.equal(await evalJS("document.activeElement.id"),'document-input');
const cases=[
 ['equation-lim.hwp',s=>assert.match(s,/>lim<\/text>/)],
 ['shape-001.hwp',s=>assert.match(s,/<path /)],
 ['묶은세로막대형.hwp',s=>assert.match(s,/hwp-ooxml-chart/)],
 ['pic-in-table-01.hwp',s=>assert.match(s,/<image /)],
 ['pic-in-head-01.hwp',s=>assert.match(s,/<image /)],
 ['pic2.hwpx',s=>assert.match(s,/<image /)],
 ['2734559_mixed_column_grid.hwpx',s=>assert.match(s,/<text /)],
 ['formatting_table.hml',s=>assert.match(s,/t<\/text>/)],
 ['hwp3-sample.hwp',s=>assert.match(s,/<image /)],
 ['footnote-01.hwp',s=>assert.match(s,/<text /)],
 ['table_scattered_header_rowbreak.hwp',s=>assert.match(s,/<line /)]
];
for(const [name,check] of cases){const status=await select(sampleDir+name);assert.doesNotMatch(status,/오류/);await mode('document');check(await svg());console.log('PASS viewer:',name,status);}
assert.ok(Number(await evalJS("document.querySelector('#page-number').max"))>2);
await evalJS("document.querySelector('#next-page').click()");await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");assert.equal(await evalJS("document.querySelector('#page-number').value"),'2');
await evalJS("document.querySelector('#page-number').value=9999;document.querySelector('#page-number').dispatchEvent(new Event('change'))");await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");assert.equal(await evalJS("document.querySelector('#next-page').disabled"),true);
await evalJS("document.querySelector('#previous-page').click()");await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");assert.equal(await evalJS("document.querySelector('#next-page').disabled"),false);
await mode('text');assert.match(await evalJS("document.querySelector('#preview').textContent"),/품질시험/);assert.equal(await evalJS("document.querySelector('#zoom').disabled"),true);
await mode('document');await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");
for(const name of ['HWP3-password-123456.hwp','HWP5-password-123456.hwpx','hwp3-sample16-hwp5-2024-password-123456.hwp']){
 await select(sampleDir+name);assert.equal(await evalJS("document.querySelector('#password-form').hidden"),false);
 await evalJS("document.querySelector('#password').value='wrong';document.querySelector('#password-form').requestSubmit()");
 await waitFor("document.querySelector('#status').textContent.includes('일치')");assert.equal(await evalJS("document.querySelector('.page-image')"),null);
 await evalJS("document.querySelector('#password').value='123456';document.querySelector('#password-form').requestSubmit()");
 await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");assert.equal(await evalJS("document.querySelector('#password').value"),'');assert.equal(await evalJS("document.querySelector('#password-form').hidden"),true);
 assert.match(await svg(),/<text /);assert.equal(await evalJS("document.querySelector('#save').disabled"),true);console.log('PASS password:',name);
}
const distribution=join(projectDir,'한글문서파일형식_배포용문서_revision1.2.hwp');
if(existsSync(distribution)){await select(distribution);await mode('document');assert.match(await svg(),/<text /);assert.equal(await evalJS("document.querySelector('#save').disabled"),true);}

await select(join(projectDir,'hwp file for test.hwp'));
const originalDoc=new HwpDocument(readFileSync(join(projectDir,'hwp file for test.hwp')));
const originalControls=JSON.parse(originalDoc.getControls()).map(c=>c.ctrlId);originalDoc.free();
await settled();
if(originalControls.includes('tbl')) {
 const cellPoint=await linePoint(3);await call('Input.dispatchMouseEvent',{type:'mousePressed',...cellPoint,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...cellPoint,button:'left',clickCount:1});
 assert.match(await evalJS("document.querySelector('#status').textContent"),/보기만/);
 assert.equal(await evalJS("document.querySelector('#save').disabled"),true);
}
await clickLine();
await evalJS("{const f=document.querySelector('#document-input');f.value+=' 본문 편집 테스트';f.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#save').click()}");
await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
const tableDownload=join(downloadDir,'hwp file for test_수정.hwp');for(let i=0;i<40&&!existsSync(tableDownload);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(tableDownload));
const editedTableDoc=new HwpDocument(readFileSync(tableDownload));assert.match(editedTableDoc.getTextRange(0,0,0,editedTableDoc.getParagraphLength(0,0)),/본문 편집 테스트/);assert.deepEqual(JSON.parse(editedTableDoc.getControls()).map(c=>c.ctrlId),originalControls);editedTableDoc.free();
const editorShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(join(downloadDir,'editor.png'),Buffer.from(editorShot.data,'base64'));
await mode('document');assert.match(await svgText(),/서울은/);

await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
assert.equal(await evalJS('document.documentElement.scrollWidth <= window.innerWidth'),true);
assert.ok(await evalJS("document.querySelector('.page-image').getBoundingClientRect().width <= document.querySelector('#preview').clientWidth"));
await evalJS("document.querySelector('#zoom').value='1.5';document.querySelector('#zoom').dispatchEvent(new Event('change'))");assert.equal(await evalJS('document.documentElement.scrollWidth <= window.innerWidth'),true);
assert.ok(await evalJS("document.querySelector('#preview').scrollWidth > document.querySelector('#preview').clientWidth"));
await evalJS("document.querySelector('#zoom').value='fit';document.querySelector('#zoom').dispatchEvent(new Event('change'))");
await evalJS("document.querySelector('#preview').scrollIntoView({block:'start'})");
await call('Emulation.setTouchEmulationEnabled',{enabled:true});
const touchPoint=await linePoint();
await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchPoint,id:1}]});
await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await waitFor("document.activeElement.id === 'document-input'");
await evalJS("{const f=document.querySelector('#document-input');f.setSelectionRange(f.value.length,f.value.length)}");
await call('Input.insertText',{text:' 휴대폰 입력'});await settled();assert.match(await svgText(),/휴대폰입력/);
assert.equal(await evalJS('document.documentElement.scrollWidth <= window.innerWidth'),true);
await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
await call('Emulation.setTouchEmulationEnabled',{enabled:false});
const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(join(downloadDir,'mobile.png'),Buffer.from(shot.data,'base64'));
await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
await select(sampleDir+'pic2.hwpx');await mode('text');assert.match(await evalJS("document.querySelector('#preview').textContent"),/대한민국/);
await mode('document');await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");
const shot2=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(join(downloadDir,'desktop.png'),Buffer.from(shot2.data,'base64'));

// 화면 전환 중 늦게 도착한 쪽 응답과 처리 제한 타이머를 확인합니다.
await evalJS(`window.pendingEngineTimers=new Set();const originalSetTimeout=window.setTimeout,originalClearTimeout=window.clearTimeout;
window.setTimeout=(fn,ms,...args)=>{const id=originalSetTimeout(fn,ms,...args);if(ms===45000)pendingEngineTimers.add(id);return id};
window.clearTimeout=id=>{pendingEngineTimers.delete(id);originalClearTimeout(id)};
document.querySelector('#next-page').click();document.querySelector('#view-mode').value='text';document.querySelector('#view-mode').dispatchEvent(new Event('change'));`);
await evalJS("new Promise(r=>setTimeout(r,1500))");assert.equal(await evalJS("pendingEngineTimers.size"),0);
assert.equal(await evalJS("document.querySelector('#view-mode').value"),'text');assert.equal(await evalJS("document.querySelector('.page-image')"),null);
await mode('document');await waitFor("document.querySelector('.page-image')?.naturalWidth > 0");
const hostile=sampleDir+'hostile.hml';writeFileSync(hostile,'<HWPML Version="2.91"><HEAD SecCnt="1"/><BODY><SECTION Id="0"><P><TEXT><CHAR>&lt;img src=x onerror=window.hwpXss=1&gt;</CHAR></TEXT></P></SECTION></BODY></HWPML>');
await evalJS('window.hwpXss=0');await select(hostile);assert.equal(await evalJS('window.hwpXss'),0);
assert.equal(await evalJS("document.querySelectorAll('#preview img').length"),1);
await mode('text');assert.match(await evalJS("document.querySelector('#preview').textContent"),/<img src=x onerror=/);
assert.equal(await evalJS("document.querySelectorAll('#preview img').length"),0);assert.equal(await evalJS('window.hwpXss'),0);
await mode('document');
const bad=sampleDir+'bad.hwp';writeFileSync(bad,Uint8Array.of(0,1,2,3));assert.ok((await select(bad)).length>0);
assert.equal(await evalJS("document.querySelector('#save').disabled"),true);assert.equal(await evalJS("document.querySelector('.page-image')"),null);
const drm=sampleDir+'drm.hwp';writeFileSync(drm,Buffer.from('SCDSA004protected'));assert.ok((await select(drm)).length>0);
assert.equal(await evalJS("document.querySelector('#password-form').hidden"),true);
await select(sampleDir+'plain.hwp');await mode('document');assert.match(await svgText(),/서울은/);
assert.deepEqual(exceptions,[]);
console.log('PASS: paginated HWP/HWPX/HML/HWP3; images/equations/charts/shapes; notes/header samples; protected files/wrong password; distribution files; navigation; safe image rendering; on-page editing/IME/caret/selection/keyboard; undo/redo; variable-length save/reopen; pending edits at save; click-to-edit; mobile zoom; no exceptions');console.log('Downloads and screenshots:',downloadDir);ws.close();
