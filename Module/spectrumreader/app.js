(function(){
'use strict';
const core=window.EGSV2Core;
const $=id=>document.getElementById(id);
const camera=$('cameraInput'), file=$('fileInput'), batch=$('batchInput'), progress=$('progressCard'), previewCard=$('previewCard'), resultCard=$('resultCard');
const preview=$('previewImage'), overlay=$('overlayCanvas');
const APP_VERSION='2.0.7-r25-RC2-dev2', APP_BRANCH='r25-RC2-dev2', APP_BUILD='20260822-spectrumreader-2.0.7-r25-RC2-dev2';
let currentUrl=null, originalSize=null, analysisSize=null;
let worker=null,jobSeq=0,pending=new Map(),activeRun=0;
let batchItems=[]; let batchRunning=false;
function createWorker(){
  try{
    const w=new Worker('./worker.js?v=2.0.7-r25-RC2-dev2');
    w.onmessage=e=>{const m=e.data||{},p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Object.assign(new Error(m.error||'Worker analysis failed'),{stack:m.stack||''}));};
    w.onerror=e=>{for(const p of pending.values())p.reject(new Error(e.message||'Worker error'));pending.clear();if(worker===w)worker=null;};
    return w;
  }catch(_){return null;}
}
function resetWorker(){
  if(worker){try{worker.terminate()}catch(_){}}
  for(const p of pending.values())p.reject(Object.assign(new Error('Analysis superseded'),{code:'SUPERSEDED'}));
  pending.clear(); worker=createWorker();
}
worker=createWorker();

function show(el,on=true){el.classList.toggle('hidden',!on)}
function setProgress(text){$('progressText').textContent=text;show(progress,true);show(resultCard,false)}
function nextFrame(){return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}

async function fileToRGBA(file,runId){
  const url=URL.createObjectURL(file);
  const img=new Image(); img.decoding='async'; img.src=url; await img.decode();
  if(runId!==activeRun){URL.revokeObjectURL(url);throw Object.assign(new Error('Analysis superseded'),{code:'SUPERSEDED'});}
  if(currentUrl)URL.revokeObjectURL(currentUrl); currentUrl=url;
  originalSize={width:img.naturalWidth,height:img.naturalHeight};
  analysisSize={width:img.naturalWidth,height:img.naturalHeight};
  preview.src=url; show(previewCard,true);
  // Preserve source pixels here. The v2 core owns canonicalization; an extra UI resize
  // can change safe axis margins and therefore is intentionally not performed.
  const c=document.createElement('canvas'); c.width=img.naturalWidth;c.height=img.naturalHeight;
  const x=c.getContext('2d',{willReadFrequently:true,alpha:false});x.drawImage(img,0,0);
  const rgba=x.getImageData(0,0,c.width,c.height);
  // Release the full-resolution canvas backing store immediately. The ImageData buffer
  // is transferred (not copied) to the Worker below, so source pixels remain exact.
  c.width=1;c.height=1;
  return rgba;
}

function analyzeRGBA(rgba,timeoutMs=30000){
  if(!worker)return Promise.resolve(core.analyze(rgba));
  const id=++jobSeq, buffer=rgba.data.buffer;
  // Transfer ownership of the original ImageData buffer. Do not allocate a second
  // full-resolution RGBA copy: this preserves pixels exactly and cuts peak memory.
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      const p=pending.get(id);if(!p)return;pending.delete(id);
      if(worker){try{worker.terminate()}catch(_){} worker=createWorker();}
      resolve({accepted:false,status:'needs_attention',stage:'analysis',reason:'Analysis exceeded the safety time limit before reaching a trustworthy result.'});
    },timeoutMs);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});
    worker.postMessage({type:'analyze',id,width:rgba.width,height:rgba.height,buffer},[buffer]);
  });
}


async function decodeFileRGBA(file){
  const url=URL.createObjectURL(file);
  try{
    const img=new Image(); img.decoding='async'; img.src=url; await img.decode();
    const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
    const x=c.getContext('2d',{willReadFrequently:true,alpha:false}); x.drawImage(img,0,0);
    const rgba=x.getImageData(0,0,c.width,c.height); c.width=1;c.height=1;
    return {rgba,width:img.naturalWidth,height:img.naturalHeight};
  }finally{URL.revokeObjectURL(url);}
}
function resultLooksSuspect(result){
  if(!result||!result.accepted)return true;
  if(!result.axis||!result.axis.accepted)return true;
  if(!result.low||!result.high||!Number.isFinite(result.low.mean)||!Number.isFinite(result.high.mean))return true;
  if(result.gridAnchorInvariant && result.gridAnchorInvariant.accepted===false)return true;
  if(result.traceCenterCalibration && result.traceCenterCalibration.accepted===false)return true;
  if(result.traceConfidence && result.traceConfidence.score<85)return true;
  const vals=(result.axis.values||[]).filter(Number.isFinite);
  if(vals.length>=2){
    const lo=Math.min(...vals), hi=Math.max(...vals), span=Math.max(1e-12,hi-lo);
    if(result.low.mean<lo-span*.75||result.low.mean>hi+span*.75||result.high.mean<lo-span*.75||result.high.mean>hi+span*.75)return true;
  }
  return false;
}
function batchStatusText(item){
  if(item.state==='queued')return 'Queued';
  if(item.state==='running')return 'Analyzing…';
  if(item.state==='error')return 'Error';
  if(!item.result)return '—';
  return item.result.accepted?'Accepted':'Needs attention';
}
function renderBatch(){
  const card=$('batchCard'), list=$('batchList'); show(card,batchItems.length>0);
  const done=batchItems.filter(x=>x.state==='done'||x.state==='error').length;
  const accepted=batchItems.filter(x=>x.result&&x.result.accepted).length;
  const suspect=batchItems.filter(x=>x.suspect).length;
  $('batchSummary').textContent=batchRunning?`${done}/${batchItems.length} analyzed · ${accepted} accepted · ${suspect} flagged`:`${batchItems.length} files · ${accepted} accepted · ${suspect} flagged for review`;
  list.innerHTML='';
  for(const item of batchItems){
    const row=document.createElement('div'); row.className=`batch-row ${item.suspect?'suspect':(item.result?.accepted?'accepted':'')}`;
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=!!item.selected; cb.disabled=item.state==='running'||item.state==='queued'; cb.setAttribute('aria-label',`Select ${item.file.name} for evidence export`); cb.onchange=()=>{item.selected=cb.checked;updateExportButton();};
    const img=document.createElement('img');img.className='batch-thumb';img.alt='';img.src=item.thumbUrl;
    const main=document.createElement('div');main.className='batch-main';
    const fileName=document.createElement('div');fileName.className='batch-file';fileName.textContent=item.file.name;
    const status=document.createElement('div');status.className='batch-status';status.textContent=batchStatusText(item);
    const values=document.createElement('div');values.className='batch-values';
    if(item.result?.accepted)values.textContent=`Low ${Number(item.result.low.mean).toFixed(5)} · High ${Number(item.result.high.mean).toFixed(5)}`;
    else values.textContent='';
    main.append(fileName,status,values);
    if(item.suspect){const r=document.createElement('div');r.className='batch-reason';r.textContent=item.result?.accepted?'Auto-flagged: accepted result needs review':friendlyReason(item.result||{reason:item.error,stage:'analysis'});main.append(r);}
    row.append(cb,img,main);list.append(row);
  }
  updateExportButton();
}
function updateExportButton(){const n=batchItems.filter(x=>x.selected&&x.state==='done').length;$('exportSelected').disabled=n===0;$('exportSelected').textContent=n?`Export selected evidence ZIP (${n})`:'Export selected evidence ZIP';}
function crc32(bytes){let c=0xffffffff;for(let i=0;i<bytes.length;i++){c^=bytes[i];for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function u16(n){return new Uint8Array([n&255,(n>>>8)&255])} function u32(n){return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255])}
function concatBytes(parts){let n=0;for(const p of parts)n+=p.length;const out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
async function makeStoreZip(entries){
  const enc=new TextEncoder(), local=[], central=[]; let offset=0;
  for(const e of entries){const name=enc.encode(e.name), data=e.data instanceof Uint8Array?e.data:new Uint8Array(e.data);const crc=crc32(data);
    const lh=concatBytes([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]);
    local.push(lh,data);
    const ch=concatBytes([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]); central.push(ch); offset+=lh.length+data.length;
  }
  const cd=concatBytes(central), body=concatBytes(local);const end=concatBytes([u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(cd.length),u32(body.length),u16(0)]);return new Blob([body,cd,end],{type:'application/zip'});
}
function safeName(name){return name.replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'')||'image';}
async function annotatedPng(item){
  const url=URL.createObjectURL(item.file);
  try{const img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);drawResultOnContext(ctx,img.naturalWidth,img.naturalHeight,item.result);return await new Promise(r=>c.toBlob(r,'image/png'));}finally{URL.revokeObjectURL(url);}
}
function drawResultOnContext(ctx,w,h,result){
  if(!result?.accepted||!result.plot)return; const scale=canonicalScaleFor(w,h),p=result.plot,canon=result.canonical||{w:500,h:240};
  function line(samples,color,dash){if(!samples||samples.length<2)return;ctx.save();ctx.lineWidth=Math.max(3,w/520);ctx.strokeStyle=color;ctx.setLineDash(dash?[10,6]:[]);ctx.beginPath();let started=false;for(const s of samples){const xCan=p.left+(s.x/500)*(p.right-p.left);const yCan=p.top+(s.yCanonical/Math.max(1,canon.h-1))*(p.bottom-p.top);const x=xCan/scale,y=yCan/scale;if(!Number.isFinite(x)||!Number.isFinite(y))continue;if(!started){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y)}ctx.stroke();ctx.restore();}
  line(result.low?.displayLine||result.low?.acceptedSamples,'#ff3b30',false);line(result.high?.displayLine||result.high?.acceptedSamples,'#00e5ff',true);
}
async function exportSelectedEvidence(){
  const selected=batchItems.filter(x=>x.selected&&x.state==='done'); if(!selected.length)return;
  $('exportSelected').disabled=true;$('exportSelected').textContent='Building ZIP…';
  const enc=new TextEncoder(), entries=[], summary=[['file','status','auto_flagged','low','high','stage','reason'].join(',')];
  for(let i=0;i<selected.length;i++){
    const item=selected[i],base=String(i+1).padStart(2,'0')+'_'+safeName(item.file.name.replace(/\.[^.]+$/,''));
    const orig=new Uint8Array(await item.file.arrayBuffer()); const ext=(item.file.name.match(/\.[A-Za-z0-9]+$/)||['.img'])[0];entries.push({name:`${base}/source${ext}`,data:orig});
    const png=await annotatedPng(item); if(png)entries.push({name:`${base}/analysis_overlay.png`,data:new Uint8Array(await png.arrayBuffer())});
    const payload={exportVersion:1,appVersion:APP_VERSION,build:APP_BUILD,file:{name:item.file.name,type:item.file.type,size:item.file.size,lastModified:item.file.lastModified},autoFlagged:item.suspect,result:item.result};entries.push({name:`${base}/analysis.json`,data:enc.encode(JSON.stringify(payload,null,2))});
    const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;summary.push([q(item.file.name),item.result?.accepted?'accepted':'needs_attention',item.suspect?'yes':'no',item.result?.low?.mean??'',item.result?.high?.mean??'',q(item.result?.stage||''),q(item.result?.reason||'')].join(','));
  }
  entries.unshift({name:'batch_summary.csv',data:enc.encode(summary.join('\n'))});entries.unshift({name:'README.txt',data:enc.encode(`Energy Graph Simple ${APP_VERSION}\nSelected evidence export\nEach folder contains the original image, annotated overlay image when available, and full analysis JSON.\n`)});
  const zip=await makeStoreZip(entries);const a=document.createElement('a');a.href=URL.createObjectURL(zip);a.download=`EnergyGraphScan_${APP_BRANCH}_evidence_${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1500);updateExportButton();
}
async function analyzeBatch(files){
  if(batchRunning||!files?.length)return; batchRunning=true; activeRun++; resetWorker();
  for(const old of batchItems){if(old.thumbUrl)URL.revokeObjectURL(old.thumbUrl)}
  batchItems=Array.from(files).map((f,i)=>({id:i+1,file:f,thumbUrl:URL.createObjectURL(f),state:'queued',result:null,error:null,suspect:false,selected:false}));renderBatch();
  for(let i=0;i<batchItems.length;i++){
    const item=batchItems[i];item.state='running';renderBatch();
    try{const {rgba}=await decodeFileRGBA(item.file);const result=await analyzeRGBA(rgba,45000);item.result=result;item.state='done';item.suspect=resultLooksSuspect(result);item.selected=item.suspect;}
    catch(err){item.error=String(err?.message||err);item.result={accepted:false,status:'needs_attention',stage:'analysis',reason:item.error};item.state='error';item.suspect=true;item.selected=true;}
    renderBatch();await nextFrame();
  }
  batchRunning=false;renderBatch();$('batchCard').scrollIntoView({behavior:'smooth',block:'start'});
}

function canonicalScaleFor(w,h){const s=1200/Math.max(w,h);return Math.abs(s-1)<.01?1:s}
function clearOverlay(){const ctx=overlay.getContext('2d');overlay.width=1;overlay.height=1;ctx.clearRect(0,0,1,1)}
function drawAcceptedLines(result){
  const ctx=overlay.getContext('2d'); const w=analysisSize.width,h=analysisSize.height;overlay.width=w;overlay.height=h;ctx.clearRect(0,0,w,h);
  drawResultOnContext(ctx,w,h,result);
}
function friendlyReason(result){
  const r=String(result.reason||'');
  if(result.stage==='geometry')return 'Capture only the black Energy per Band plot. Keep the complete plot, X=0–500 grid, and visible Y-axis labels in frame.';
  if(result.stage==='axis')return 'Y-axis scale could not be read safely. Keep the green numeric Y labels sharp and fully visible.';
  if(result.stage==='trace'){
    if(/sampling consensus/i.test(r))return 'The trace changed too much across internal sampling checks. Retake the photo more sharply and avoid UI overlays or other plotted data.';
    if(/identity mismatch/i.test(r))return 'Low and High appear to come from different foreground traces. Retake the graph without overlapping traces or UI elements.';
    if(/population margin/i.test(r))return 'Two different trace populations were too similar to choose safely. Retake the graph with the Energy trace clearly separated.';
    if(/Low foreground persistence/i.test(r))return 'The Low range looked like a short UI/marker cluster instead of a continuous trace. Retake with only the Energy plot visible.';
    if(/High foreground span/i.test(r))return 'The High range did not span enough of the graph to identify safely. Retake with the full Energy plot visible.';
    if(/Bilateral X lattice|X=500 right-edge|X=0 vertical axis/i.test(r))return 'The Energy grid edges could not be confirmed safely. Keep the complete X=0–500 black plot in frame, including both left and right grid edges.';
    if(/too localized across X/i.test(r))return 'Accepted trace samples were concentrated in only part of the X range. Retake with the full 0–500 Energy plot sharp and unobstructed.';
    if(/Y distribution is unstable/i.test(r))return 'Accepted trace samples were too vertically inconsistent to report a safe average. Retake the Energy plot sharply and without overlapping marks.';
    if(/excessive extrapolation/i.test(r))return 'The trace would require too much extrapolation beyond the visible Y-axis labels. Retake with more Y-axis labels visible.';
    return 'The Energy trace could not be separated safely from UI or other plotted data. Retake the photo with only the Energy per Band plot visible.';
  }
  return result.reason||'Safe validation did not converge.';
}
function summarize(result){
  return JSON.stringify({appVersion:APP_VERSION,branch:APP_BRANCH,build:APP_BUILD,status:result.status,stage:result.stage||'done',reason:result.reason||null,plot:result.plot?{left:result.plot.left,right:result.plot.right,vStep:result.plot.vStep}:null,axis:result.axis?.accepted?{step:result.axis.step,slope:result.axis.slope,intercept:result.axis.intercept,mode:result.axis.diagnostics?.mode}:null,low:result.low?{mean:result.low.mean,count:result.low.count}:null,high:result.high?{mean:result.high.mean,count:result.high.count}:null,traceConfidence:result.traceConfidence||null,traceStability:result.traceStability?{lowStepSpan:result.traceStability.lowStepSpan,highStepSpan:result.traceStability.highStepSpan,marginConsensus:result.traceStability.marginConsensus}:null,gainRange:result.gainRange||null,traceCenterCalibration:result.traceCenterCalibration||null,gridAnchorInvariant:result.gridAnchorInvariant||null},null,2)
}
function showConfidence(result){
  const c=result.traceConfidence, card=$('confidenceCard');
  if(!result.accepted||!c){show(card,false);return;}
  show(card,true);card.classList.remove('strong','good','borderline');card.classList.add(c.level);
  $('confidenceValue').textContent=`${c.score}/100 · ${c.level}`;
  $('confidenceBar').style.width=`${c.score}%`;
  const names={sampling:'Sampling',lowPersistence:'Low continuity',highSpan:'High span',identity:'Trace identity',margin:'Population margin',grid:'Grid separation'};
  $('confidenceParts').innerHTML=Object.entries(c.parts||{}).map(([k,v])=>`<span>${names[k]||k}: ${v}</span>`).join('');
}
function resetForNewImage(){
  show(resultCard,false);show($('values'),false);show($('attention'),false);show($('confidenceCard'),false);$('diagText').textContent='';$('lowValue').textContent='—';$('highValue').textContent='—';$('confidenceValue').textContent='—';$('confidenceBar').style.width='0';$('confidenceParts').textContent='';clearOverlay();
}
async function analyzeFile(file){
  if(!file)return;
  const runId=++activeRun; resetWorker(); resetForNewImage();
  try{
    setProgress('Decoding captured image'); await nextFrame();
    const rgba=await fileToRGBA(file,runId); if(runId!==activeRun)return;
    setProgress('Running v2 safe analysis'); await nextFrame();
    const result=await analyzeRGBA(rgba); if(runId!==activeRun)return;
    drawAcceptedLines(result); show(progress,false); show(resultCard,true);
    $('diagText').textContent=summarize(result);showConfidence(result);
    if(result.accepted){
      $('resultState').textContent='Analysis accepted';show($('values'),true);show($('attention'),false);
      $('lowValue').textContent=Number(result.low.mean).toFixed(5);$('highValue').textContent=Number(result.high.mean).toFixed(5);
      resultCard.scrollIntoView({behavior:'smooth',block:'start'});resultCard.focus({preventScroll:true});
    }else{
      $('resultState').textContent='Analysis not accepted';show($('values'),false);show($('attention'),true);
      $('attentionReason').textContent=friendlyReason(result);
      resultCard.scrollIntoView({behavior:'smooth',block:'start'});
    }
  }catch(err){if(runId!==activeRun||err?.code==='SUPERSEDED')return;show(progress,false);show(resultCard,true);show($('values'),false);show($('attention'),true);$('resultState').textContent='Analysis error';$('attentionReason').textContent=String(err&&err.message||err);$('diagText').textContent=String(err&&err.stack||err);resultCard.scrollIntoView({behavior:'smooth',block:'start'});}
}
[camera,file].forEach(inp=>inp.addEventListener('change',()=>{const f=inp.files&&inp.files[0]; if(f)analyzeFile(f); inp.value='';}));
batch.addEventListener('change',()=>{const fs=batch.files; if(fs&&fs.length)analyzeBatch(fs); batch.value='';});
$('exportSelected').addEventListener('click',()=>exportSelectedEvidence().catch(err=>alert('Evidence export failed: '+String(err?.message||err))));
$('selectSuspect').addEventListener('click',()=>{for(const x of batchItems)x.selected=!!x.suspect;renderBatch();});
$('selectRejected').addEventListener('click',()=>{for(const x of batchItems)x.selected=!!(x.result&&!x.result.accepted);renderBatch();});
$('selectAllBatch').addEventListener('click',()=>{for(const x of batchItems)x.selected=x.state==='done';renderBatch();});
$('clearBatchSelection').addEventListener('click',()=>{for(const x of batchItems)x.selected=false;renderBatch();});
window.addEventListener('resize',()=>{if(preview.naturalWidth){overlay.style.width=preview.clientWidth+'px';overlay.style.height=preview.clientHeight+'px';}});
window.addEventListener('pagehide',()=>{if(currentUrl)URL.revokeObjectURL(currentUrl);for(const x of batchItems){if(x.thumbUrl)URL.revokeObjectURL(x.thumbUrl)}if(worker)worker.terminate();});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
})();
