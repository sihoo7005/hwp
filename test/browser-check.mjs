import {writeFileSync,readFileSync,existsSync,mkdtempSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const projectDir=fileURLToPath(new URL('../',import.meta.url));
import assert from 'node:assert/strict';
const downloadDir=mkdtempSync(join(tmpdir(),'hwp-browser-download-'));
const targets=await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let sequence=0,fileChoosers=0;const pending=new Map();const exceptions=[];
ws.onclose=()=>{for(const p of pending.values())p.reject(new Error('Test browser disconnected'));pending.clear()};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});else if(m.method==='Page.fileChooserOpened')fileChoosers++};
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));})}
async function evalJS(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function waitFor(expression){await evalJS(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const poll=()=>{if(${expression})resolve(true);else if(Date.now()>end)reject(new Error('UI timeout'));else setTimeout(poll,100)};poll()})`)}
async function clickSelector(selector){const point=await evalJS(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});}
await call('Runtime.enable');await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
await call('Page.navigate',{url:process.argv[2] || 'http://127.0.0.1:8765/'});
await waitFor("document.querySelector('#file') && document.querySelector('#status') && document.readyState === 'complete'");
await new Promise(resolve=>setTimeout(resolve,300));
assert.ok(await evalJS("document.querySelector('.empty-document button[data-open-file]') !== null"));
assert.equal(await evalJS("document.documentElement.scrollHeight <= window.innerHeight"),true,'app fills viewport without outer scrolling');
await call('Page.setInterceptFileChooserDialog',{enabled:true});
const chooserRoot=await call('DOM.getDocument');const chooserInput=await call('DOM.querySelector',{nodeId:chooserRoot.root.nodeId,selector:'#file'});
await clickSelector('#open-file');await call('DOM.setFileInputFiles',{nodeId:chooserInput.nodeId,files:[]});
await clickSelector('.empty-document [data-open-file]');await call('DOM.setFileInputFiles',{nodeId:chooserInput.nodeId,files:[]});
await new Promise(r=>setTimeout(r,100));assert.equal(fileChoosers,2,'both open buttons launch the native file chooser');
await call('Page.setInterceptFileChooserDialog',{enabled:false});
await evalJS("document.querySelector('#help').click()");assert.equal(await evalJS("document.querySelector('#help-dialog').open"),true);
await evalJS("document.querySelector('#help-dialog button[aria-label=\"안내 닫기\"]').click()");assert.equal(await evalJS("document.querySelector('#help-dialog').open"),false);
const emptyShot=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(downloadDir,'empty.png'),Buffer.from(emptyShot.data,'base64'));

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
assert.equal(await evalJS("document.querySelector('#document-title').textContent"),'plain.hwp');
assert.ok(await evalJS("document.querySelector('#preview').clientHeight > window.innerHeight * .7"),'paper gets most of the viewport');
assert.equal(await evalJS("document.querySelector('#view-mode').value"),'document');
const droppedBytes=readFileSync(sampleDir+'plain.hwp').toString('base64');
await evalJS(`{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(droppedBytes)}),c=>c.charCodeAt(0))],'끌어놓기 테스트.hwp'));document.querySelector('#preview').dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));if(!document.querySelector('.workspace').classList.contains('file-drag'))throw new Error('No drop highlight');document.querySelector('#preview').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));}`);
await settled();assert.equal(await evalJS("document.querySelector('#document-title').textContent"),'끌어놓기 테스트.hwp');
assert.equal(await evalJS("document.querySelector('.workspace').classList.contains('file-drag')"),false);
await select(sampleDir+'plain.hwp');await settled();
assert.equal(await evalJS("document.querySelector('#text-editor')"),null,'no separate paragraph form');
await clickLine();assert.equal(await evalJS("document.activeElement.dataset.paragraph"),'0');
assert.ok(await evalJS("document.querySelector('.document-caret') !== null"));
// A mobile IME can recompose the whole word before the original caret.
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await evalJS("{const f=document.querySelector('#document-input');f.setSelectionRange(3,3)}");
await call('Input.imeSetComposition',{text:'서울시는',selectionStart:4,selectionEnd:4,replacementStart:0,replacementEnd:3});
await waitFor("document.querySelector('.composition-text')?.textContent==='서울시는'");
assert.equal(await evalJS("document.querySelector('#preview-state').textContent"),'원본');
assert.ok(await evalJS("document.querySelector('#document-input').value.startsWith('서울시는 ')") );
assert.ok(await evalJS("document.querySelector('.composition-mask')?.getBoundingClientRect().width>0"),'old word is covered');
assert.equal(await evalJS("getComputedStyle(document.querySelector('.composition-text')).borderBottomStyle"),'none');
const imeLeft=await evalJS("document.querySelector('.composition-text').getBoundingClientRect().left");
assert.ok(Math.abs(imeLeft-(await linePoint(0,0)).x)<2,'whole-word composition starts at the original word');
await call('Input.imeSetComposition',{text:'서울',selectionStart:2,selectionEnd:2});
assert.equal(await evalJS("document.querySelector('.composition-text').textContent"),'서울');
await call('Input.imeSetComposition',{text:'서울시는',selectionStart:4,selectionEnd:4});
await call('Input.insertText',{text:'서울시는'});await settled();
assert.ok(await evalJS("document.querySelector('#document-input').value.startsWith('서울시는 ')") );
assert.equal(await evalJS("document.querySelector('.composition-text')"),null,'preview removed after page refresh');
await evalJS("document.querySelector('#undo').click()");await waitFor("document.querySelector('#document-input').value.startsWith('서울은 ')");await settled();
await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
console.log('PASS mobile whole-word IME: mask, correct position, shortening, single commit, undo');
// The same focused input and paper remain mounted throughout typing and rendering.
await evalJS("window.editorInput=document.activeElement;window.editorPaper=document.querySelector('.page-surface')");
const changed='부산광역시😀에서 새 문장을 입력합니다.\n다음 줄도 저장합니다.';
await evalJS(`const field=document.querySelector('#document-input');field.dispatchEvent(new CompositionEvent('compositionstart'));field.value=${JSON.stringify(changed)};field.setSelectionRange(7,7);field.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'광역시'}));`);
await evalJS("new Promise(r=>setTimeout(r,300))");assert.equal(await evalJS("document.querySelector('#preview-state').textContent"),'원본','composition not committed early');
assert.match(await evalJS("document.querySelector('.composition-text').textContent"),/부산광역시/);
assert.ok(await evalJS("document.querySelector('.composition-mask') !== null"));
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

// Edit adjacent cells, IME, blank space and an empty merged cell in both saved formats.
const cellBase=new HwpDocument(readFileSync(sampleDir+'plain.hwp'));
cellBase.insertParagraph(0,3);cellBase.createTable(0,3,0,2,3);cellBase.mergeTableCells(0,3,0,1,0,1,1);
cellBase.insertTextInCell(0,3,0,0,0,0,'첫셀');cellBase.insertTextInCell(0,3,0,1,0,0,'옆셀');
const cellBoxes=JSON.parse(cellBase.getTableCellBboxes(0,3,0,0));
for(const format of ['hwp','hwpx'])writeFileSync(join(downloadDir,'cells.'+format),format==='hwp'?cellBase.exportHwp():cellBase.exportHwpx());cellBase.free();
async function clickCell(index,blank=false,touch=false){
 const b=cellBoxes.find(c=>c.cellIdx===index);
 const point=await evalJS(`(()=>{const image=document.querySelector('.page-image'),box=image.getBoundingClientRect(),scale=box.width/Number(image.dataset.width);return {x:box.left+${b.x+(blank?b.w-20:10)}*scale,y:box.top+${b.y+b.h/2}*scale}})()`);
 if(touch){await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 else{await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});}
 await waitFor(`document.activeElement.id==='document-input' && document.activeElement.dataset.cell==='${index}'`);
}
for(const format of ['hwp','hwpx']){
 await select(join(downloadDir,'cells.'+format));await settled();
 await clickCell(0,true);assert.equal(await evalJS("document.querySelector('#document-input').value"),'첫셀');
 await evalJS("{window.cellInput=document.activeElement;const f=document.activeElement;f.dispatchEvent(new CompositionEvent('compositionstart'));f.value='첫셀 한글😀';f.setSelectionRange(f.value.length,f.value.length);f.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'첫셀 한글😀'}))}");
 await evalJS('new Promise(r=>setTimeout(r,150))');assert.equal(await evalJS("document.querySelector('#preview-state').textContent"),'원본');
 assert.equal(await evalJS("document.querySelector('.composition-text').textContent"),'첫셀 한글😀');
 assert.ok(await evalJS("document.querySelector('.composition-mask')!==null"),'cell whole-word composition hides existing letters');
 await evalJS("document.activeElement.dispatchEvent(new CompositionEvent('compositionend'))");await settled();
 assert.equal(await evalJS('document.activeElement===cellInput'),true);assert.match(await svgText(),/첫셀한글/);
 await clickCell(1);assert.equal(await evalJS("document.querySelector('#document-input').value"),'옆셀');
 await call('Input.insertText',{text:'옆칸 입력'});await settled();
 await clickCell(3,true);assert.equal(await evalJS("document.querySelector('#document-input').value"),'');
 await call('Input.insertText',{text:'병합 빈셀😀\n둘째 줄'});await settled();
 await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
 const saved=join(downloadDir,'cells_수정.'+format);for(let i=0;i<40&&!existsSync(saved);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(saved));
 const check=new HwpDocument(readFileSync(saved));assert.equal(check.getTextInCell(0,3,0,0,0,0,20000),'첫셀 한글😀');assert.match(check.getTextInCell(0,3,0,1,0,0,20000),/옆칸 입력/);assert.equal(check.getTextInCell(0,3,0,3,0,0,20000),'병합 빈셀😀\n둘째 줄');assert.equal(JSON.parse(check.getCellInfo(0,3,0,3)).colSpan,2);check.free();
 await select(saved);await settled();assert.match(await svgText(),/병합빈셀/);
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Emulation.setTouchEmulationEnabled',{enabled:true});
 await clickCell(1,false,true);await call('Input.insertText',{text:' 터치 입력'});await settled();assert.match(await svgText(),/터치입력/);
 assert.equal(await evalJS('document.documentElement.scrollWidth<=window.innerWidth'),true);
 await call('Emulation.setTouchEmulationEnabled',{enabled:false});await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
 console.log('PASS table editing:',format,'IME, adjacent/empty/merged cells, save/reopen, touch');
}

await select(join(projectDir,'hwp file for test.hwp'));
const originalDoc=new HwpDocument(readFileSync(join(projectDir,'hwp file for test.hwp')));
const originalControls=JSON.parse(originalDoc.getControls()).map(c=>c.ctrlId);
const firstCell=JSON.parse(originalDoc.getCursorModel()).lists.find(c=>c.isCell&&c.hostListId===0);
const originalCellText=firstCell ? originalDoc.getTextInCell(firstCell.sectionIndex,firstCell.hostPara,firstCell.controlIndex,firstCell.cellIndex,0,0,20000) : '';originalDoc.free();
await settled();
if(originalControls.includes('tbl')) {
 const cellPoint=await linePoint(3);await call('Input.dispatchMouseEvent',{type:'mousePressed',...cellPoint,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...cellPoint,button:'left',clickCount:1});
 assert.equal(await evalJS("document.querySelector('#document-input').dataset.cell"),String(firstCell.cellIndex));
 assert.equal(await evalJS("document.querySelector('#document-input').value"),originalCellText);
 await evalJS("{const f=document.querySelector('#document-input');f.setSelectionRange(f.value.length,f.value.length)}");
 await call('Input.insertText',{text:' 셀 편집😀'});await settled();assert.match(await svgText(),/셀편집/);
 await evalJS("document.querySelector('#undo').click()");await waitFor("document.querySelector('#preview').dataset.revision === '0' && document.querySelector('#save').disabled");await settled();
 assert.equal(await evalJS("document.querySelector('#document-input').value"),originalCellText);
 await evalJS("document.querySelector('#redo').click()");await waitFor("document.querySelector('#document-input').value.includes('셀 편집😀')");await settled();
 assert.match(await evalJS("document.querySelector('#document-input').value"),/셀 편집😀/);
}
await clickLine();
await evalJS("{const f=document.querySelector('#document-input');f.value+=' 본문 편집 테스트';f.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#save').click()}");
await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
const tableDownload=join(downloadDir,'hwp file for test_수정.hwp');for(let i=0;i<40&&!existsSync(tableDownload);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(tableDownload));
const editedTableDoc=new HwpDocument(readFileSync(tableDownload));assert.match(editedTableDoc.getTextRange(0,0,0,editedTableDoc.getParagraphLength(0,0)),/본문 편집 테스트/);assert.deepEqual(JSON.parse(editedTableDoc.getControls()).map(c=>c.ctrlId),originalControls);
if(firstCell)assert.equal(editedTableDoc.getTextInCell(firstCell.sectionIndex,firstCell.hostPara,firstCell.controlIndex,firstCell.cellIndex,0,0,20000),originalCellText+' 셀 편집😀');editedTableDoc.free();
const editorShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(join(downloadDir,'editor.png'),Buffer.from(editorShot.data,'base64'));
await mode('document');assert.match(await svgText(),/서울은/);

await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
assert.equal(await evalJS('document.documentElement.scrollWidth <= window.innerWidth'),true);
assert.equal(await evalJS('document.documentElement.scrollHeight <= window.innerHeight'),true);
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
// 사진 도구는 실제 포인터·파일 선택·클립보드·터치와 저장 후 픽셀까지 확인합니다.
const picturePng=await evalJS(`(()=>{const c=document.createElement('canvas');c.width=320;c.height=160;const g=c.getContext('2d');
for(const [color,x,y] of [['#ff0000',0,0],['#00ff00',160,0],['#0000ff',0,80],['#ffff00',160,80]]){g.fillStyle=color;g.fillRect(x,y,160,80)}return c.toDataURL('image/png').split(',')[1]})()`);
const pictureFile=join(downloadDir,'photo.png');writeFileSync(pictureFile,Buffer.from(picturePng,'base64'));
const pictureBase=new HwpDocument(readFileSync(sampleDir+'plain.hwp'));
pictureBase.insertParagraph(0,3);pictureBase.createTable(0,3,0,2,2);pictureBase.insertTextInCell(0,3,0,0,0,0,'사진 셀');
const madePicture=JSON.parse(pictureBase.insertPicture(0,0,3,'[]',Buffer.from(picturePng,'base64'),12000,6000,320,160,'png','사진 검사'));
pictureBase.setPictureProperties(0,0,madePicture.controlIdx,'{"treatAsChar":true}');
const {picturesOnPage,pictureProps}=await import(new URL('../picture-core.mjs',import.meta.url));
for(const format of ['hwp','hwpx'])writeFileSync(join(downloadDir,'pictures.'+format),format==='hwp'?pictureBase.exportHwp():pictureBase.exportHwpx());
const originalPicture=picturesOnPage(pictureBase,0).find(p=>p.editable);pictureBase.free();
async function picturePoint(rect,dx=0,dy=0){return await evalJS(`(()=>{const i=document.querySelector('.page-image'),b=i.getBoundingClientRect(),s=b.width/Number(i.dataset.width);return {x:b.left+${rect.x+rect.w/2+dx}*s,y:b.top+${rect.y+rect.h/2+dy}*s}})()`)}
async function mouseClick(point){await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})}
async function pictureCommit(expression){const rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));await evalJS(expression);await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();}
async function textPoint(text){return await evalJS(`fetch(document.querySelector('.page-image').src).then(r=>r.text()).then(s=>{const rows=new Map();for(const t of new DOMParser().parseFromString(s,'image/svg+xml').querySelectorAll('text')){const key=Math.round(Number(t.getAttribute('y'))*10);if(!rows.has(key))rows.set(key,[]);rows.get(key).push(t)}const row=[...rows.values()].find(row=>row.map(t=>t.textContent).join('').replaceAll(' ','').includes(${JSON.stringify(text.replace(' ',''))}));if(!row)throw new Error('text not visible');const t=row[0],i=document.querySelector('.page-image'),b=i.getBoundingClientRect(),scale=b.width/Number(i.dataset.width);return {x:b.left+(Number(t.getAttribute('x'))+3)*scale,y:b.top+(Number(t.getAttribute('y'))-4)*scale}})`)}
for(const format of ['hwp','hwpx']) {
 await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});
 await select(join(downloadDir,'pictures.'+format));await settled();
 await mouseClick(await picturePoint(originalPicture));await waitFor("!document.querySelector('#picture-panel').hidden");
 assert.equal(await evalJS("document.querySelector('.picture-frame').hidden"),false);
 await pictureCommit("{const w=document.querySelector('#picture-width');w.value='60';w.dispatchEvent(new Event('input'));document.querySelector('#picture-size-apply').click()}");
 assert.equal(await evalJS("document.querySelector('#picture-width').value"),'60.0');
 const widthBefore=Number(await evalJS("document.querySelector('#picture-width').value"));
 const handle=await evalJS("(()=>{const b=document.querySelector('.picture-handle.se').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()");
 let rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));
 await call('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x+20,y:handle.y+10,button:'left',buttons:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x+20,y:handle.y+10,button:'left',clickCount:1});
 await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();
 assert.ok(Number(await evalJS("document.querySelector('#picture-width').value"))>widthBefore);
 await pictureCommit("document.querySelector('#picture-rotate-right').click()");
 assert.equal(await evalJS("document.querySelector('#picture-angle').value"),'90');
 await pictureCommit("{const s=document.querySelector('#picture-layout');s.value='InFrontOfText';s.dispatchEvent(new Event('change'))}");
 const center=await evalJS("(()=>{const b=document.querySelector('.picture-frame').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()");
 const xBefore=Number(await evalJS("document.querySelector('#picture-x').value"));rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));
 await call('Input.dispatchMouseEvent',{type:'mousePressed',...center,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:center.x+25,y:center.y+15,button:'left',buttons:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:center.x+25,y:center.y+15,button:'left',clickCount:1});
 await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();
 assert.ok(Number(await evalJS("document.querySelector('#picture-x').value"))>xBefore);
 await pictureCommit("document.querySelector('#picture-align-center').click()");
 await call('Page.setInterceptFileChooserDialog',{enabled:true});
 await evalJS("document.querySelector('#picture-replace').click()");
 const photoInput=await call('DOM.querySelector',{nodeId:root.root.nodeId,selector:'#picture-file'});
 rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));
 await call('DOM.setFileInputFiles',{nodeId:photoInput.nodeId,files:[pictureFile]});
 await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();
 await call('Page.setInterceptFileChooserDialog',{enabled:false});
 await pictureCommit("document.querySelector('#picture-crop-left').value=50;document.querySelector('#picture-crop button').click()");
 const croppedRect=await evalJS("(()=>{const s=document.querySelector('.picture-frame').style;return {x:parseFloat(s.left),y:parseFloat(s.top),w:parseFloat(s.width),h:parseFloat(s.height)}})()");
 await pictureCommit("document.querySelector('#picture-delete').click()");assert.equal(await evalJS("document.querySelector('#picture-panel').hidden"),true);
 rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));
 await evalJS("document.querySelector('#undo').click()");await waitFor(`Number(document.querySelector('#preview').dataset.revision) === ${rev-1}`);await settled();
 await mouseClick(await picturePoint(croppedRect));await waitFor("!document.querySelector('#picture-panel').hidden");
 await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
 const saved=join(downloadDir,'pictures_수정.'+format);for(let i=0;i<40&&!existsSync(saved);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(saved));
 const reopened=new HwpDocument(readFileSync(saved));const p=picturesOnPage(reopened,0).find(p=>p.editable);
 assert.equal(pictureProps(reopened,p).rotationAngle,90);assert.equal(pictureProps(reopened,p).horzAlign,'Center');
 const cropBytes=reopened.getControlImageData(p.section,p.paragraph,JSON.stringify(p.path),p.control);reopened.free();
 assert.equal(Buffer.from(cropBytes).readUInt32BE(16),160,'자른 사진의 실제 픽셀 너비');
 const pixel=await evalJS(`(async()=>{const b=Uint8Array.from(atob(${JSON.stringify(Buffer.from(cropBytes).toString('base64'))}),c=>c.charCodeAt(0));const img=await createImageBitmap(new Blob([b],{type:'image/png'}));const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const g=c.getContext('2d');g.drawImage(img,0,0);img.close();return [...g.getImageData(5,5,1,1).data]})()`);
 assert.deepEqual(pixel,[0,255,0,255],'자르기는 화면과 저장한 사진에 함께 적용');
 unlinkSync(saved);
 await evalJS("document.querySelector('#picture-close').click()");await mouseClick(await textPoint('나는 서울'));await waitFor("document.activeElement.id==='document-input'");
 await call('Page.setInterceptFileChooserDialog',{enabled:true});await evalJS("document.querySelector('#picture-add').click()");
 rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));await call('DOM.setFileInputFiles',{nodeId:photoInput.nodeId,files:[pictureFile]});
 await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();await call('Page.setInterceptFileChooserDialog',{enabled:false});
 await evalJS("document.querySelector('#picture-close').click()");await mouseClick(await textPoint('서울의 날씨'));
 await pictureCommit(`{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(picturePng)}),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'}));document.querySelector('#document-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))}`);
 await evalJS("document.querySelector('#picture-close').click()");const cellPoint=await textPoint('사진 셀');
 await pictureCommit(`{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(picturePng)}),c=>c.charCodeAt(0))],'drop.png',{type:'image/png'}));document.querySelector('#preview').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:${cellPoint.x},clientY:${cellPoint.y}}))}`);
 const desktopPicture=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(downloadDir,'pictures-desktop-'+format+'.png'),Buffer.from(desktopPicture.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await call('Emulation.setTouchEmulationEnabled',{enabled:true});
 await evalJS("document.querySelector('.picture-frame').scrollIntoView({block:'center'})");
 assert.equal(await evalJS('document.documentElement.scrollWidth <= window.innerWidth'),true);
 const mobileHandle=await evalJS("(()=>{const b=document.querySelector('.picture-handle.se').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width}})()");assert.ok(mobileHandle.w>=23,'모바일 조절점은 확대 비율과 관계없이 터치 크기를 유지');
 rev=Number(await evalJS("document.querySelector('#preview').dataset.revision"));
 await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:mobileHandle.x,y:mobileHandle.y}]});
 await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:mobileHandle.x+15,y:mobileHandle.y+10}]});
 await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await waitFor(`Number(document.querySelector('#preview').dataset.revision) !== ${rev} && !document.querySelector('#undo').disabled`);await settled();
 await evalJS("document.querySelector('#save').click()");await waitFor("document.querySelector('#status').textContent.includes('다운로드를 시작')");
 for(let i=0;i<40&&!existsSync(saved);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(saved));
 const finalPictures=new HwpDocument(readFileSync(saved));
 try {let count=0;for(let page=0;page<finalPictures.pageCount();page++)count+=picturesOnPage(finalPictures,page).filter(p=>p.editable).length;
 assert.equal(count,4);assert.equal(finalPictures.getTextInCell(0,3,0,0,0,0,20000),'사진 셀');assert.match(finalPictures.getTextRange(0,1,0,20000),/나는 서울/);}finally{finalPictures.free();}
 const mobilePicture=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(downloadDir,'pictures-mobile-'+format+'.png'),Buffer.from(mobilePicture.data,'base64'));
 await call('Emulation.setTouchEmulationEnabled',{enabled:false});
 console.log('PASS picture editor:',format,'selection, numeric/drag resize, rotate, move, align, replace, crop pixels, delete/undo, insert, paste/drop, table cell, mobile touch and save');
}
assert.deepEqual(exceptions,[]);
console.log('PASS: paginated HWP/HWPX/HML/HWP3; images/equations/charts/shapes; notes/header samples; protected files/wrong password; distribution files; navigation; safe image rendering; on-page body and table cell editing/IME/caret/selection/keyboard; undo/redo; variable-length save/reopen; pending edits at save; click-to-edit; mobile zoom; no exceptions');console.log('Downloads and screenshots:',downloadDir);ws.close();
