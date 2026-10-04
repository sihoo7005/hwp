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
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails)};
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
 await waitFor("(!document.querySelector('#text-editor').hidden && document.querySelector('#text-editor textarea')) || document.querySelector('.page-image')?.naturalWidth > 0 || !document.querySelector('#password-form').hidden || document.querySelector('#status').dataset.error === 'true'");
 return await evalJS("document.querySelector('#viewer-status').textContent || document.querySelector('#status').textContent");
}
async function svg(){return await evalJS("fetch(document.querySelector('.page-image').src).then(r=>r.text())")}
async function svgText(){return await evalJS("fetch(document.querySelector('.page-image').src).then(r=>r.text()).then(s=>new DOMParser().parseFromString(s,'image/svg+xml').documentElement.textContent.replace(/\\n/g,''))")}
async function mode(value){await evalJS(`document.querySelector('#view-mode').value=${JSON.stringify(value)};document.querySelector('#view-mode').dispatchEvent(new Event('change'))`);await waitFor(value==='document'?"document.querySelector('.page-image')?.naturalWidth > 0":value==='edit'?"!document.querySelector('#text-editor').hidden":"document.querySelector('.engine-text') !== null")}
assert.match(await select(sampleDir+'plain.hwp'),/HWP · 1쪽/);
assert.equal(await evalJS("document.querySelector('#view-mode').value"),'edit');
const changed='부산광역시😀에서 새 문장을 입력합니다.\n다음 줄도 저장합니다.';
await evalJS(`const field=document.querySelector('#paragraph-0-0');field.focus();field.dispatchEvent(new CompositionEvent('compositionstart'));field.value=${JSON.stringify(changed)};field.setSelectionRange(7,7);field.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));`);
await evalJS("new Promise(r=>setTimeout(r,500))");assert.equal(await evalJS("document.querySelector('#preview-state').textContent"),'원본','composition not committed early');
await evalJS("document.querySelector('#paragraph-0-0').dispatchEvent(new CompositionEvent('compositionend'))");
await waitFor("document.querySelector('#preview-state').textContent === '수정 중'");
assert.equal(await evalJS("document.activeElement.id"),'paragraph-0-0');assert.equal(await evalJS("document.activeElement.selectionStart"),7,'caret retained');
assert.equal(await evalJS("document.querySelector('#paragraph-0-0').value"),changed);
await evalJS("document.querySelector('#undo').click()");await waitFor("document.querySelector('#paragraph-0-0').value.includes('서울은')");
assert.equal(await evalJS("document.querySelector('#save').disabled"),true,'undo returns clean initial document');
await evalJS("document.querySelector('#redo').click()");await waitFor("document.querySelector('#paragraph-0-0').value.includes('부산광역시')");
await mode('document');assert.match(await svgText(),/부산광역시/);await mode('text');assert.match(await evalJS("document.querySelector('#preview').textContent"),/다음 줄도/);await mode('edit');
await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
const download=downloadDir+'/plain_수정.hwp';for(let i=0;i<40&&!existsSync(download);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(download));
const {default:init,HwpDocument}=await import(new URL('../node_modules/@rhwp/core/rhwp.js',import.meta.url));
await init({module_or_path:readFileSync(new URL('../node_modules/@rhwp/core/rhwp_bg.wasm',import.meta.url))});
const reopened=new HwpDocument(readFileSync(download));assert.equal(reopened.getTextRange(0,0,0,reopened.getParagraphLength(0,0)),changed);reopened.free();
assert.equal(await evalJS("document.querySelector('#save').disabled"),true);
// 입력 반영 대기 중에 저장해도 여러 문단의 최신 텍스트를 저장합니다.
await evalJS("for(const [id,text] of [['paragraph-0-1','둘째 문단을 새로 씁니다.'],['paragraph-0-2','셋째 문단도 변경합니다.']]){const f=document.getElementById(id);f.value=text;f.dispatchEvent(new InputEvent('input',{bubbles:true}))}document.querySelector('#save').click()");
await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작') && document.querySelector('#save').disabled");
assert.equal(await evalJS("document.querySelector('#paragraph-0-1').value"),'둘째 문단을 새로 씁니다.');
await mode('document');assert.match(await svgText(),/둘째문단/);
// 쪽의 실제 본문 위치를 클릭하면 대응 문단과 커서를 선택합니다.
const coordinates=await evalJS("fetch(document.querySelector('.page-image').src).then(r=>r.text()).then(s=>{const svg=new DOMParser().parseFromString(s,'image/svg+xml');const t=svg.querySelector('text');const image=document.querySelector('.page-image'),b=image.getBoundingClientRect(),w=Number(image.dataset.width);return {x:b.left+(Number(t.getAttribute('x'))+3)*b.width/w,y:b.top+(Number(t.getAttribute('y'))-5)*b.width/w}})");
await call('Input.dispatchMouseEvent',{type:'mousePressed',x:coordinates.x,y:coordinates.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:coordinates.x,y:coordinates.y,button:'left',clickCount:1});
await waitFor("document.querySelector('#view-mode').value === 'edit'");assert.equal(await evalJS('document.activeElement.id'),'paragraph-0-0');
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
if(originalControls.includes('tbl'))assert.equal(await evalJS("document.querySelector('#paragraph-0-4').readOnly"),true);
await evalJS("const f=document.querySelector('#paragraph-0-0');f.value+=' 본문 편집 테스트';f.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#save').click()");
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
console.log('PASS: paginated HWP/HWPX/HML/HWP3; images/equations/charts/shapes; notes/header samples; protected files/wrong password; distribution files; navigation; safe image rendering; direct text editing/IME/caret; undo/redo; variable-length save/reopen; pending edits at save; click-to-edit; mobile zoom; no exceptions');console.log('Downloads and screenshots:',downloadDir);ws.close();
