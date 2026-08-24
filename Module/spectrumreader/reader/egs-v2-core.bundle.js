(function(global){
"use strict";
var modules={
'core_v2_canonical_pipeline37_family_arbitrated.js': function(module,exports,require){
'use strict';
/*
 * v2.0.7-r24 unified measurement pipeline
 *
 * One authoritative measurement flow:
 *   geometry -> final grid anchors -> one affine axis -> overlay mask ->
 *   trace-center consensus -> one generic X/population segmentation ->
 *   one affine projection -> physical invariants -> result.
 *
 * No post-hoc numeric correction is permitted.  All reported values are projections
 * of accepted trace-center pixels through the same affine axis fitted from the final
 * tick/grid anchors.
 */
const G=require('./core_v2_geometry11_bilateral_fallback.js');
const A=require('./core_v2_axis_resolver52_family_arbitration.js');
const T=require('./core_v2_trace17_continuity_path.js');
const RUNTIME_CORE='pipeline37-axis52-trace17-r25rc2-gainpop3-projection-rescue1';

function canonicalizeRGBA(img,targetLong=1200){
  const W=img.width,H=img.height,s=targetLong/Math.max(W,H);
  if(Math.abs(s-1)<.01)return{...img,canonicalScale:1};
  const nw=Math.max(1,Math.round(W*s)),nh=Math.max(1,Math.round(H*s)),d=new Uint8ClampedArray(nw*nh*4);
  for(let y=0;y<nh;y++){
    const sy=Math.min(H-1,Math.max(0,Math.round((y+.5)/s-.5)));
    for(let x=0;x<nw;x++){
      const sx=Math.min(W-1,Math.max(0,Math.round((x+.5)/s-.5))),si=(sy*W+sx)*4,di=(y*nw+x)*4;
      d[di]=img.data[si];d[di+1]=img.data[si+1];d[di+2]=img.data[si+2];d[di+3]=255;
    }
  }
  return{data:d,width:nw,height:nh,canonicalScale:s};
}
function finite(a){return a.filter(Number.isFinite)}
function mean(a){const v=finite(a);return v.length?v.reduce((s,x)=>s+x,0)/v.length:NaN}
function median(a){const v=finite(a).sort((x,y)=>x-y);if(!v.length)return NaN;const m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function wrapperUiPreflight(img){
  // Conservative corpus-hygiene guard for portrait app/result screenshots.
  // Direct monitor photos can be portrait, so aspect ratio alone is never enough.
  // Require a dark app-like top region + dark overall chrome + a substantial bright
  // control/card population in that same top region.  This only rejects wrapper UI;
  // it does not influence axis/trace calibration or reported values.
  const W=img.width,H=img.height;if(!(H>W*1.10))return null;
  const nx=80,ny=80,topRows=28;let darkTop=0,brightTop=0,darkAll=0,topN=0,allN=0;
  for(let gy=0;gy<ny;gy++){
    const y=Math.min(H-1,Math.max(0,Math.round((gy+.5)*H/ny-.5)));
    for(let gx=0;gx<nx;gx++){
      const x=Math.min(W-1,Math.max(0,Math.round((gx+.5)*W/nx-.5))),i=(y*W+x)*4;
      const lum=.299*img.data[i]+.587*img.data[i+1]+.114*img.data[i+2];
      if(lum<50)darkAll++;allN++;
      if(gy<topRows){if(lum<50)darkTop++;if(lum>200)brightTop++;topN++;}
    }
  }
  const fDarkTop=darkTop/Math.max(1,topN),fBrightTop=brightTop/Math.max(1,topN),fDarkAll=darkAll/Math.max(1,allN);
  if(fDarkTop>.50&&fDarkAll>.50&&fBrightTop>.095)return{reason:'Wrapper/app-result screenshot detected before measurement.',darkTop:fDarkTop,darkAll:fDarkAll,brightTop:fBrightTop};
  return null;
}

function fitFinalAxis(axis){
  if(!axis?.accepted||!Array.isArray(axis.rows)||!Array.isArray(axis.values)||axis.rows.length!==axis.values.length)
    return{...(axis||{}),accepted:false,reason:'Resolved Y-axis anchors are incomplete.'};
  const pts=axis.rows.map((y,i)=>({y:Number(y),v:Number(axis.values[i])})).filter(p=>Number.isFinite(p.y)&&Number.isFinite(p.v)).sort((a,b)=>a.y-b.y);
  if(pts.length<2)return{...axis,accepted:false,reason:'At least two final Y-axis grid anchors are required.'};
  for(let i=1;i<pts.length;i++)if(!(pts[i].y>pts[i-1].y&&pts[i].v<pts[i-1].v))return{...axis,accepted:false,reason:'Y-axis anchors are not strictly monotone.'};
  const my=mean(pts.map(p=>p.y)),mv=mean(pts.map(p=>p.v));
  let num=0,den=0;for(const p of pts){num+=(p.y-my)*(p.v-mv);den+=(p.y-my)*(p.y-my)}
  if(!(den>0))return{...axis,accepted:false,reason:'Y-axis grid anchors have no usable vertical span.'};
  const slope=num/den,intercept=mv-slope*my;
  if(!(Number.isFinite(slope)&&slope<0&&Number.isFinite(intercept)))return{...axis,accepted:false,reason:'Y-axis affine direction is invalid.'};
  const residuals=pts.map(p=>slope*p.y+intercept-p.v);
  const step=Math.max(1e-12,Math.abs(Number(axis.step)||median(pts.slice(1).map((p,i)=>p.v-pts[i].v))||1));
  const maxResidual=Math.max(...residuals.map(Math.abs));
  const affineGate=step*.06;
  if(maxResidual<=affineGate)return{...axis,slope,intercept,step,mapY:y=>slope*y+intercept,unifiedAxis:{mode:'final-grid-anchor-least-squares',maxResidual,residuals,points:pts}};
  // Perspective-safe 3+ anchor mapping. No coefficient correction: interpolate through physical anchors themselves.
  if(pts.length>=3){
    const dys=pts.slice(1).map((p,i)=>p.y-pts[i].y),dmin=Math.min(...dys),dmax=Math.max(...dys);
    const distortion=dmax/Math.max(1e-9,dmin)-1;
    if(distortion<=.38){
      const mapY=y=>{
        if(y<=pts[0].y){const a=pts[0],b=pts[1];return a.v+(y-a.y)*(b.v-a.v)/(b.y-a.y)}
        if(y>=pts.at(-1).y){const a=pts.at(-2),b=pts.at(-1);return a.v+(y-a.y)*(b.v-a.v)/(b.y-a.y)}
        for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1];if(y>=a.y&&y<=b.y)return a.v+(y-a.y)*(b.v-a.v)/(b.y-a.y)}
        return NaN;
      };
      return{...axis,slope,intercept,step,mapY,unifiedAxis:{mode:'final-grid-anchor-monotone-piecewise',maxResidual,residuals,points:pts,spacingDistortion:distortion}};
    }
  }
  return{...axis,accepted:false,reason:'Final Y-axis grid anchors are not affine-consistent.',unifiedAxis:{maxResidual,step,residuals,points:pts}};
}
function repairRejectedDecimalPair(img,axis){
  const d=axis?.diagnostics||{},labels=d.labels;
  if(axis?.accepted||!Array.isArray(labels)||labels.length!==2||!Number.isFinite(d.axisX))return axis;
  const values=labels.map(x=>Number(x));
  if(values.some(v=>!Number.isFinite(v)||v<=0)||!(values[0]>values[1]))return axis;
  const x0=Math.max(0,Math.round(d.axisX)),right0=Math.min(img.width-1,x0+5),right1=Math.min(img.width-1,x0+Math.max(120,Math.round((d.r22FamilyArbitration?.baseInk?.vStep||60)*9)));
  const left0=Math.max(0,x0-Math.max(100,Math.round((d.r22FamilyArbitration?.baseInk?.vStep||60)*3.4))),left1=Math.max(left0,x0-5);
  const green=(r,g,b)=>g>=55&&g>r*1.12&&g>b*1.02;
  const rows=[];
  for(let y=2;y<img.height-2;y++){
    let rc=0;for(let x=right0;x<=right1;x++){const i=(y*img.width+x)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))rc++}
    if(rc<Math.max(18,(right1-right0)*.035))continue;
    let lc=0;for(let yy=Math.max(0,y-9);yy<=Math.min(img.height-1,y+9);yy++)for(let x=left0;x<=left1;x++){const i=(yy*img.width+x)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))lc++}
    // Require literal label ink near the candidate row; this suppresses trace/grid-only rows.
    if(lc<40)continue;
    rows.push({y,rc,lc,score:rc});
  }
  // Collapse nearby rows to one physical horizontal band.
  rows.sort((a,b)=>a.y-b.y);const bands=[];
  for(const q of rows){const b=bands.at(-1);if(b&&q.y-b.maxY<=5){b.maxY=q.y;b.items.push(q);if(q.score>b.best.score)b.best=q}else bands.push({minY:q.y,maxY:q.y,best:q,items:[q]})}
  let cand=bands.map(b=>{const sw=b.items.reduce((a,q)=>a+q.rc,0)||1;const y=Math.round(b.items.reduce((a,q)=>a+q.y*q.rc,0)/sw);return{...b.best,y,band:[b.minY,b.maxY]}});
  const original=(d.latticeRows||[]).filter(Number.isFinite);if(original.length){const lo=Math.min(...original)-35,hi=Math.max(...original.slice(0,2))+35;cand=cand.filter(q=>q.y>=lo&&q.y<=hi)}
  let best=null;
  for(let i=0;i<cand.length;i++)for(let j=i+1;j<cand.length;j++){
    const a=cand[i],b=cand[j],gap=b.y-a.y;if(gap<45||gap>260)continue;
    const score=a.score+b.score;
    if(!best||score>best.score)best={a,b,score,gap};
  }
  if(!best)return axis;
  const old=(d.latticeRows||[]).slice(0,2);const changed=old.length===2&&(Math.abs(best.a.y-old[0])<=12||Math.abs(best.b.y-old[1])<=12)&&Math.max(Math.abs(best.a.y-old[0]),Math.abs(best.b.y-old[1]))>=18;
  if(!changed)return axis;
  const step=Math.abs(values[0]-values[1]),slope=(values[1]-values[0])/(best.b.y-best.a.y),intercept=values[0]-slope*best.a.y;
  return{...axis,accepted:true,rows:[best.a.y,best.b.y],values,step,slope,intercept,reason:null,diagnostics:{...d,mode:'r25-physical-decimal-pair-rebind',physicalRows:[best.a.y,best.b.y],physicalRowEvidence:[best.a,best.b],previousRows:old}};
}

function resolveAxisForPlot(img,plot){
  try{return fitFinalAxis(repairRejectedDecimalPair(img,A.resolve(img,plot)))}
  catch(e){return{accepted:false,reason:e&&e.message?e.message:'Axis resolution failed.',diagnostics:{mode:'axis-resolve-exception'}}}
}
function axisValueSignature(axis){
  if(!axis?.accepted||!Array.isArray(axis.values)||axis.values.length<2)return null;
  return axis.values.map(v=>Number(v).toPrecision(8)).join('|');
}
function multiScaleAxisConsensus(raw,baseLong=1200){
  // Decoder-resilience fallback.  It is only reached after the canonical 1200px
  // axis path and the independent projection geometry both fail.  Several nearby
  // canonical scales must independently resolve the SAME physical Y-label family;
  // one lucky scale is never sufficient.
  const trials=[];
  for(const target of [900,1000,1050,1150]){
    const ci=canonicalizeRGBA(raw,target);let p;
    try{p=G.findPlot(ci)}catch(_){continue}
    const a=resolveAxisForPlot(ci,p);if(!a.accepted)continue;
    const sig=axisValueSignature(a);if(!sig)continue;
    trials.push({target,plot:p,axis:a,sig,normRows:a.rows.map(y=>Number(y)/target)});
  }
  const groups=new Map();for(const q of trials){if(!groups.has(q.sig))groups.set(q.sig,[]);groups.get(q.sig).push(q)}
  const ranked=[...groups.values()].sort((a,b)=>b.length-a.length);if(!ranked.length||ranked[0].length<3)return null;
  if(ranked[1]&&ranked[1].length===ranked[0].length)return null;
  const win=ranked[0],n=win[0].axis.values.length;if(win.some(q=>q.axis.values.length!==n||q.normRows.length!==n))return null;
  const normRows=[];let inlierFloor=Infinity;
  for(let i=0;i<n;i++){
    const vals=win.map(q=>q.normRows[i]).filter(Number.isFinite),m=median(vals);if(!Number.isFinite(m))return null;
    const tol=.015,inliers=vals.filter(v=>Math.abs(v-m)<=tol);inlierFloor=Math.min(inlierFloor,inliers.length);if(inliers.length<3)return null;
    normRows.push(median(inliers));
  }
  const rows=normRows.map(v=>v*baseLong),values=win[0].axis.values.map(Number),step=Math.abs(Number(win[0].axis.step)||median(values.slice(1).map((v,i)=>v-values[i]))||1);
  const rescued=fitFinalAxis({accepted:true,rows,values,step,diagnostics:{mode:'r25-rc2-multiscale-axis-consensus',signature:win[0].sig,agreeingScales:win.map(q=>q.target),trialCount:trials.length,inlierFloor,normRows}});
  return rescued.accepted?rescued:null;
}

function refinePlotFromAxis(plot,axis,img){
  let p={...plot};
  const rr=finite(axis.rows||[]).sort((a,b)=>a-b);
  if(rr.length>=2){
    const ds=rr.slice(1).map((y,i)=>y-rr[i]).filter(d=>d>4),rowStep=ds.length?median(ds):(Number(p.hStep)||NaN),zeroY=-axis.intercept/axis.slope;
    if(Number.isFinite(rowStep)&&rowStep>8&&Number.isFinite(zeroY)){
      const zeroSteps=(zeroY-rr.at(-1))/rowStep;
      if(zeroSteps>=.55&&zeroSteps<=1.45&&zeroY<img.height-4){
        const topBound=Math.max(0,Math.round(rr[0]-rowStep*.55)),bottomBound=Math.min(img.height-1,Math.round(zeroY+rowStep*.22));
        const box={...p.box,top:Math.max(p.box?.top??0,topBound),bottom:Math.min(p.box?.bottom??img.height-1,bottomBound)};box.h=box.bottom-box.top+1;
        p={...p,h:[...rr,zeroY],hStep:rowStep,top:rr[0],bottom:zeroY,box,unifiedAffineCrop:{zeroY,rowStep,topBound,bottomBound}};
      }
    }
  }
  if(axis.diagnostics?.verifiedUnitStep&&Number.isFinite(axis.diagnostics.axisX)){
    const left=axis.diagnostics.axisX,step=p.vStep,halfStepMajor=!!p?.geometryGate?.halfStepMajorRows;
    // In the half-step/perspective recovery class, Y-label X and Sample#0 are
    // independently solved.  Do not overwrite the data lattice with label X unless
    // both independently agree.  Other established compact paths keep legacy behavior.
    const agrees=!halfStepMajor||(Number.isFinite(step)&&Number.isFinite(p.left)&&Math.abs(left-p.left)<=step*.28);
    if(agrees&&Number.isFinite(step)&&step>0&&left>=0&&left+10*step<img.width)
      p={...p,left,right:left+10*step,v:Array.from({length:11},(_,k)=>left+k*step),axisRelocated:true};
  }
  return p;
}

function findWhiteOverlayBoxes(img,plot){
  const left=Math.max(0,Math.round(plot.left)),right=Math.min(img.width-1,Math.round(plot.right));
  const top=Math.max(0,Math.round((plot.h?.[0]??plot.top))),bottom=Math.min(img.height-1,Math.round((plot.h?.at(-1)??plot.bottom)+(plot.hStep||40)*1.15));
  const W=right-left+1,H=bottom-top+1;if(W<80||H<50)return[];
  const sx=2,sy=2,cw=Math.ceil(W/sx),ch=Math.ceil(H/sy),mask=new Uint8Array(cw*ch);
  const bright=(r,g,b)=>{const mx=Math.max(r,g,b),mn=Math.min(r,g,b),lum=.299*r+.587*g+.114*b,sat=(mx-mn)/Math.max(1,mx);return lum>150&&sat<.26};
  const dark=(r,g,b)=>{const mx=Math.max(r,g,b),mn=Math.min(r,g,b),lum=.299*r+.587*g+.114*b,sat=(mx-mn)/Math.max(1,mx);return lum<115&&sat<.55};
  for(let yy=0;yy<ch;yy++)for(let xx=0;xx<cw;xx++){const x=Math.min(right,left+xx*sx),y=Math.min(bottom,top+yy*sy),i=(y*img.width+x)*4;if(bright(img.data[i],img.data[i+1],img.data[i+2]))mask[yy*cw+xx]=1}
  const seen=new Uint8Array(mask.length),stack=[],boxes=[];
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){
    const idx=y*cw+x;if(!mask[idx]||seen[idx])continue;seen[idx]=1;stack.push(idx);let n=0,x0=x,x1=x,y0=y,y1=y;
    while(stack.length){const q=stack.pop(),qy=Math.floor(q/cw),qx=q-qy*cw;n++;x0=Math.min(x0,qx);x1=Math.max(x1,qx);y0=Math.min(y0,qy);y1=Math.max(y1,qy);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=qx+dx,ny=qy+dy;if(nx<0||nx>=cw||ny<0||ny>=ch)continue;const ni=ny*cw+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;stack.push(ni)}}}
    const bw=(x1-x0+1)*sx,bh=(y1-y0+1)*sy,aspect=bw/Math.max(1,bh),fill=n/Math.max(1,(x1-x0+1)*(y1-y0+1));
    if(bw<Math.max(76,W*.10)||bw>W*.68||bh<Math.max(20,H*.05)||bh>H*.45||aspect<2.1||aspect>8.8||fill<.32)continue;
    const ax0=left+x0*sx,ax1=Math.min(right,left+(x1+1)*sx-1),ay0=top+y0*sy,ay1=Math.min(bottom,top+(y1+1)*sy-1),sw=ax1-ax0+1,sh=ay1-ay0+1,dm=new Uint8Array(sw*sh);
    for(let yy=0;yy<sh;yy++)for(let xx=0;xx<sw;xx++){const i=((ay0+yy)*img.width+(ax0+xx))*4;if(dark(img.data[i],img.data[i+1],img.data[i+2]))dm[yy*sw+xx]=1}
    const dseen=new Uint8Array(dm.length),dst=[];let glyphs=0;
    for(let yy=0;yy<sh;yy++)for(let xx=0;xx<sw;xx++){const di=yy*sw+xx;if(!dm[di]||dseen[di])continue;dseen[di]=1;dst.push(di);let dn=0,dx0=xx,dx1=xx,dy0=yy,dy1=yy;while(dst.length){const q=dst.pop(),qy=Math.floor(q/sw),qx=q-qy*sw;dn++;dx0=Math.min(dx0,qx);dx1=Math.max(dx1,qx);dy0=Math.min(dy0,qy);dy1=Math.max(dy1,qy);for(const [ox,oy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=qx+ox,ny=qy+oy;if(nx<0||ny<0||nx>=sw||ny>=sh)continue;const ni=ny*sw+nx;if(dm[ni]&&!dseen[ni]){dseen[ni]=1;dst.push(ni)}}}const gw=dx1-dx0+1,gh=dy1-dy0+1;if(dn>=4&&gw<=Math.max(20,sw*.12)&&gh>=5&&gh<=Math.max(34,sh*.78)&&gh/gw>=.42&&gh/gw<=8)glyphs++}
    if(glyphs>=9)boxes.push({left:ax0,right:ax1,top:ay0,bottom:ay1,glyphs,fill});
  }
  return boxes;
}
function maskOverlayBoxes(img,boxes){if(!boxes?.length)return img;const d=new Uint8ClampedArray(img.data);for(const b of boxes){const x0=Math.max(0,b.left-4),x1=Math.min(img.width-1,b.right+4),y0=Math.max(0,b.top-4),y1=Math.min(img.height-1,b.bottom+4);for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const i=(y*img.width+x)*4;d[i]=0;d[i+1]=0;d[i+2]=0;d[i+3]=255}}return{...img,data:d,maskedOverlays:boxes}}

function projectSamples(samples,plot,H,axis){
  return (samples||[]).filter(s=>Number.isFinite(s.yCanonical)&&Number.isFinite(s.x)).map(s=>{
    const axisY=plot.top+(s.yCanonical/Math.max(1,H-1))*(plot.bottom-plot.top);
    return{...s,axisY,value:(typeof axis.mapY==='function'?axis.mapY(axisY):axis.slope*axisY+axis.intercept)};
  });
}

function unifiedRangeSegmentation(raw,plot,axis){
  const H=raw.canonical?.h||240,p=T.normalizePlot(plot);
  const lowSamples=projectSamples(raw.low?.acceptedSamples,p,H,axis).filter(s=>s.x>=0&&s.x<=260);
  const highRange=projectSamples(raw.high?.acceptedSamples,p,H,axis).filter(s=>s.x>=270&&s.x<=500);
  if(lowSamples.length<5||highRange.length<5)throw Error('Too few accepted trace-center samples in fixed reporting ranges.');

  // The reporting/search contract remains Low=0-260 and High=270-500.  In Gain
  // captures the 270-500 interval can contain two physically distinct populations:
  // a continuation of the Low baseline followed by a sustained elevated High cloud.
  // Averaging both populations biases High downward.  Detect that structure from the
  // calibrated trace pixels themselves and, only when separation is strong and
  // persistent, report the elevated population.  Flat/noise traces keep the complete
  // 270-500 mean.  No image-specific coefficient or absolute value threshold is used.
  const step=Math.max(1e-12,Math.abs(axis.step||0));
  const lowMedian=median(lowSamples.map(s=>s.value));
  const tailCut=270+(500-270)*.65;
  let tail=highRange.filter(s=>s.x>=tailCut);
  if(tail.length<8)tail=highRange.slice(-Math.min(15,highRange.length));
  const tailMedian=median(tail.map(s=>s.value));
  const delta=tailMedian-lowMedian,dir=Math.sign(delta)||1;
  const threshold=lowMedian+delta*.45;
  let transitionX=NaN;
  const gainScale=(axis.values||[]).some(v=>Number.isFinite(Number(v))&&Math.abs(Number(v))>=0.5);
  const stronglySeparated=gainScale&&Number.isFinite(delta)&&Math.abs(delta)>=step*.45;
  if(stronglySeparated){
    for(let i=0;i<=highRange.length-4;i++){
      const run=highRange.slice(i,i+4);
      if(run[0].x<285)continue;
      const sustained=run.every(q=>dir*(q.value-threshold)>=0);
      const compactRun=(run.at(-1).x-run[0].x)<=Math.max(28,(500-270)*.12);
      if(sustained&&compactRun){transitionX=run[0].x;break}
    }
  }
  const elevated=Number.isFinite(transitionX)?highRange.filter(s=>s.x>=transitionX&&dir*(s.value-threshold)>=0):[];
  const useElevated=stronglySeparated&&elevated.length>=8&&transitionX<=455;
  const highSamples=useElevated?elevated:highRange;

  const make=(base,samples)=>({...base,mean:mean(samples.map(s=>s.value)),count:samples.length,acceptedSamples:samples,displayLine:samples.map(s=>({...s}))});
  const out={...raw,low:make(raw.low,lowSamples),high:make(raw.high,highSamples)};
  out.unifiedMeasurement={mode:'fixed-range-population-aware-trace-center-projection',segmentation:{mode:useElevated?'sustained-high-population':'fixed-contract',low:[0,260],high:[270,500],transitionX:Number.isFinite(transitionX)?transitionX:null,lowMedian,tailMedian,deltaSteps:delta/step,gainScale,usedHighSamples:highSamples.length,totalHighSamples:highRange.length},projection:'accepted-yCanonical -> plotY -> final-grid-map'};
  return out;
}
function physicalInvariant(tr,axis){
  const mapY=y=>(typeof axis.mapY==='function'?axis.mapY(y):axis.slope*y+axis.intercept);
  const anchors=axis.rows.map((y,i)=>({y:Number(y),value:Number(axis.values[i])})).filter(a=>Number.isFinite(a.y)&&Number.isFinite(a.value));
  if(anchors.length<2)return{ok:false,reason:'At least two Y-axis grid anchors are required.'};
  const step=Math.max(1e-12,Math.abs(axis.step||0)),fitTol=Math.max(1e-9,step*.06),valueTol=Math.max(1e-9,step*.015),pxTol=1,sides={};
  for(const a of anchors){const v=mapY(a.y);if(Math.abs(v-a.value)>fitTol)return{ok:false,reason:`Y-axis anchor/map mismatch at ${a.value}.`,anchor:a,projected:v}}
  for(const key of ['low','high']){
    const ss=(tr[key]?.acceptedSamples||[]).filter(s=>Number.isFinite(s.axisY)&&Number.isFinite(s.value));if(ss.length<5)return{ok:false,reason:`Too few calibrated ${key} trace-center samples.`};
    const medY=median(ss.map(s=>s.axisY)),meanV=mean(ss.map(s=>s.value));sides[key]={medianY:medY,mean:meanV,count:ss.length};
    for(const a of anchors){
      const below=ss.filter(s=>s.axisY>a.y+pxTol).length/ss.length,above=ss.filter(s=>s.axisY<a.y-pxTol).length/ss.length;
      if(below>=.90&&!(meanV<a.value))return{ok:false,reason:`Physical-order invariant failed: >=90% of ${key} trace is below ${a.value} but result is ${meanV}.`,anchor:a,belowFraction:below,mean:meanV};
      if(above>=.90&&!(meanV>a.value))return{ok:false,reason:`Physical-order invariant failed: >=90% of ${key} trace is above ${a.value} but result is ${meanV}.`,anchor:a,aboveFraction:above,mean:meanV};
      // Do not use median position as an ordering gate. Fixed 270-500 High windows can
      // legitimately contain a late-start mixed population (baseline + elevated cloud),
      // so the median can sit on one side of an anchor while the fixed-range mean is on
      // the other. The >=90% one-sided gate above is the release invariant.
    }
    for(const s of ss){const expected=mapY(s.axisY);if(Math.abs(expected-s.value)>fitTol)return{ok:false,reason:`Stored ${key} value is detached from accepted pixel Y.`,expected,actual:s.value,axisY:s.axisY}}
  }
  return{ok:true,anchors,sides};
}

function hueDistance(a,b){let d=Math.abs(Number(a)-Number(b))%360;return Math.min(d,360-d)}
function multiTraceAmbiguity(tr){
  // Safety-only semantic guard for screenshots where several independently persistent
  // colored traces are simultaneously present.  Without an external channel/foreground
  // cue the active/frontmost trace cannot be proven from the plot pixels alone, so do not
  // silently choose one population.  Green-family candidates are excluded because they
  // are often the physical grid/moire family already handled by trace17.
  const strongDistinct=(arr)=>{
    const cs=(arr||[]).filter(q=>q?.mode==='color'&&!(q.hue>=65&&q.hue<=170)&&
      q.coverage>=.70&&q.denseCoverage>=.65&&q.xSpanFrac>=.90&&q.gridLeakFrac<=.45)
      .sort((a,b)=>b.score-a.score);
    if(!cs.length)return null;
    const top=cs[0];
    for(const q of cs.slice(1)){
      const y0=Number(top.medianY),y1=Number(q.medianY),dy=Math.abs(y0-y1);
      // Both paths must occupy the lower/data-bearing part of the Low range.  This
      // rejects chromatic title/text aliases near the plot top (orange_compact class)
      // while retaining genuinely superimposed baseline populations.
      const dataBearing=Number.isFinite(y0)&&Number.isFinite(y1)&&y0>=132&&y1>=132&&dy>=6&&dy<=65;
      if(dataBearing&&hueDistance(top.hue,q.hue)>=70&&q.score>=top.score-1.0)
        return{primary:{hue:top.hue,score:top.score,coverage:top.coverage,medianY:y0},alternate:{hue:q.hue,score:q.score,coverage:q.coverage,medianY:y1}};
    }
    return null;
  };
  const low=strongDistinct(tr?.candidates?.low),high=strongDistinct(tr?.candidates?.high);
  return low||high?{low,high}:null;
}

function analyze(img){
  const c=canonicalizeRGBA(img),wrapper=wrapperUiPreflight(c);if(wrapper)return{accepted:false,status:'needs_attention',stage:'target',reason:wrapper.reason,wrapperUi:wrapper};let plot;
  try{plot=G.findPlot(c)}catch(e){return{accepted:false,status:'needs_attention',stage:'geometry',reason:e.message}}
  let axis=resolveAxisForPlot(c,plot);
  if(!axis.accepted){
    // Independent geometry retry on the same Safari/Canvas pixels.  This recovers
    // cases where moire/UI green rows win the primary geometry but the true Energy
    // plot's projection lattice still yields a physically valid Y-label family.
    try{const pr=G.projectionPlot(c);if(pr?.accepted){const pa=resolveAxisForPlot(c,pr);if(pa.accepted){plot=pr;axis={...pa,diagnostics:{...(pa.diagnostics||{}),rc2GeometryFallback:'projection-green-lattice'}}}}}catch(_){}
  }
  // Multi-scale axis consensus is retained as a diagnostic helper only for now.
  // Do not promote it to an accepted result until trace-selection parity is proven
  // on Safari pixels; an axis-only rescue can otherwise expose a wrong trace branch.
  if(!axis.accepted)return{accepted:false,status:'needs_attention',stage:'axis',reason:axis.reason||'Axis consensus rejected.',plot,axis};
  plot=refinePlotFromAxis(plot,axis,c);
  const overlays=findWhiteOverlayBoxes(c,plot),traceImg=maskOverlayBoxes(c,overlays);let tr;
  try{tr=unifiedRangeSegmentation(T.extractTraceConsensus(traceImg,plot,axis),plot,axis)}catch(e){return{accepted:false,status:'needs_attention',stage:'trace',reason:e.message,plot,axis,overlays}}
  const multiTrace=multiTraceAmbiguity(tr);if(multiTrace)return{accepted:false,status:'needs_attention',stage:'trace',reason:'Multiple persistent colored trace populations are present; active/frontmost trace is ambiguous.',plot,axis,overlays,multiTrace};
  const inv=physicalInvariant(tr,axis);if(!inv.ok)return{accepted:false,status:'needs_attention',stage:'trace',reason:inv.reason,plot,axis,overlays,gridAnchorInvariant:inv};
  const vals=[...(tr.low?.acceptedSamples||[]),...(tr.high?.acceptedSamples||[])].map(s=>s.value);
  if(!Number.isFinite(tr.low?.mean)||!Number.isFinite(tr.high?.mean)||tr.low.mean<0||tr.high.mean<0||vals.some(v=>!Number.isFinite(v)||v<-.000001))return{accepted:false,status:'needs_attention',stage:'trace',reason:'Non-physical Energy trace values.',plot,axis,overlays};
  return{accepted:true,status:'accepted',plot,axis,overlays,gridAnchorInvariant:inv,...tr};
}
module.exports={RUNTIME_CORE,canonicalizeRGBA,wrapperUiPreflight,fitFinalAxis,repairRejectedDecimalPair,refinePlotFromAxis,findWhiteOverlayBoxes,maskOverlayBoxes,unifiedRangeSegmentation,physicalInvariant,multiTraceAmbiguity,analyze};

},
'core_v2_geometry11_bilateral_fallback.js': function(module,exports,require){
'use strict';
const Primary=require('./core_v2_geometry10_axis_refine.js');
const Base=require('./core_v2_geometry6.js');
function green(r,g,b){const m=Math.max(r,b);return g>46&&(g-m)>=6&&g>=m*1.06&&(.299*r+.587*g+.114*b)>28}
function vstat(img,p,x){const st=p.hStep||30,y0=Math.max(0,Math.round(Math.min(...p.h)-st*.8)),y1=Math.min(img.height-1,Math.round(Math.max(...p.h)+st*.8));let hits=0,best=0,cur=0;for(let y=y0;y<=y1;y++){let ok=false;for(let dx=-1;dx<=1;dx++){const xx=Math.max(0,Math.min(img.width-1,Math.round(x+dx))),i=(y*img.width+xx)*4;if(green(img.data[i],img.data[i+1],img.data[i+2])){ok=true;break}}if(ok){hits++;cur++;if(cur>best)best=cur}else cur=0}return{occ:hits/Math.max(1,y1-y0+1),best}}
function hsupport(img,p,x){let n=0;for(const yy of p.h){let hit=false;for(let dy=-2;dy<=2&&!hit;dy++)for(let dx=-1;dx<=1&&!hit;dx++){const xx=Math.round(x+dx),y=Math.round(yy+dy);if(xx<0||xx>=img.width||y<0||y>=img.height)continue;const i=(y*img.width+xx)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))hit=true}if(hit)n++}return n}
function distinct(cands,top){return cands.find(c=>Math.abs(c.left-top.left)>Math.max(4,top.step*.28)||Math.abs(c.step-top.step)>1.2)}

function nearGreenX(img,x0,y,tol){
  let best=null;
  for(let dx=-tol;dx<=tol;dx++){
    const x=Math.round(x0+dx);if(x<0||x>=img.width)continue;
    let score=0;
    for(let dy=-2;dy<=2;dy++){
      const yy=Math.round(y+dy);if(yy<0||yy>=img.height)continue;
      const i=(yy*img.width+x)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))score++;
    }
    if(score>0&&(!best||score>best.score||score===best.score&&Math.abs(dx)<Math.abs(best.dx)))best={x,dx,score};
  }
  return best;
}
function intersectionLatticeSolve(img,p){
  const hs=(p.h||[]).filter(Number.isFinite);
  if(hs.length<2)return{accepted:false,reason:'Too few horizontal rows for intersection lattice.'};
  const base=Number.isFinite(p.vStep)?p.vStep:Math.max(12,img.width*.04);
  const stepMin=base*.82,stepMax=base*1.18,leftMin=Math.max(0,p.left-base*3.2),leftMax=Math.min(img.width-1,p.left+base*1.5);
  const cands=[];
  for(let step=stepMin;step<=stepMax;step+=.5){
    const tol=Math.max(3,Math.round(step*.13));
    for(let left=leftMin;left<=leftMax;left+=1){
      let covered=0,totalHits=0,totalErr=0,rows=[];
      for(let k=0;k<11;k++){
        const x=left+k*step,hits=[];
        for(const y of hs){const q=nearGreenX(img,x,y,tol);if(q)hits.push(q)}
        if(hits.length>=Math.min(2,hs.length))covered++;
        totalHits+=hits.length; totalErr+=hits.reduce((s,q)=>s+Math.abs(q.dx),0);
        rows.push({x,hits:hits.length,meanErr:hits.length?hits.reduce((s,q)=>s+Math.abs(q.dx),0)/hits.length:99});
      }
      const L=rows[0],R=rows[10];
      if(covered<9||L.hits<Math.min(2,hs.length)||R.hits<Math.min(2,hs.length))continue;
      const expected=11*hs.length,hitFrac=totalHits/expected,err=totalHits?totalErr/totalHits:99;
      const stepDrift=Math.abs(step-base)/Math.max(1,base);
      const leftDrift=Math.abs(left-p.left)/Math.max(1,base);
      const score=covered*5+hitFrac*24-err*1.2-stepDrift*4-leftDrift*.7;
      cands.push({score,left,step,right:left+10*step,covered,hitFrac,meanErr:err,rows});
    }
  }
  cands.sort((a,b)=>b.score-a.score);
  if(!cands.length)return{accepted:false,reason:'No intersection-supported 11-line lattice.'};
  const top=cands[0],alt=cands.find(c=>Math.abs(c.left-top.left)>Math.max(4,top.step*.30)||Math.abs(c.step-top.step)>1.2);
  const margin=alt?top.score-alt.score:99;
  const rightDriftSteps=Math.abs(top.right-p.right)/Math.max(1,base);
  if(top.hitFrac<.72||top.meanErr>Math.max(2.5,top.step*.09))return{accepted:false,reason:'Intersection lattice evidence is weak.',top,alternative:alt,margin,rightDriftSteps};
  if(rightDriftSteps>1.25)return{accepted:false,reason:'Intersection lattice right edge disagrees with the base grid.',top,alternative:alt,margin,rightDriftSteps};
  if(margin<1.25)return{accepted:false,reason:'Intersection lattice is ambiguous.',top,alternative:alt,margin,rightDriftSteps};
  return{accepted:true,...top,alternative:alt,margin,rightDriftSteps};
}

function bilateralSolve(img,p){const cache=new Map(),vs=x=>{const k=Math.round(x*2)/2;if(!cache.has(k))cache.set(k,vstat(img,p,k));return cache.get(k)};const starts=[];for(let x=Math.max(0,p.box.left-(p.vStep||24)*3.5);x<=Math.min(img.width-1,p.box.right+(p.vStep||24)*2);x+=1){const q=vs(x);if(q.best>=24&&q.occ>=.20)starts.push(x)}const baseStep=Number.isFinite(p.vStep)?p.vStep:Math.max(12,img.width*.035),stepMin=Math.max(10,baseStep*.72),stepMax=Math.min(img.width*.12,baseStep*1.30);const cands=[];for(const left of starts){for(let step=stepMin;step<=stepMax;step+=.5){let score=0,covered=0,rows=[];for(let k=0;k<11;k++){const x=left+k*step,q=vs(x),hs=hsupport(img,p,x);if(q.best>=12||q.occ>.12||hs>=2)covered++;score+=Math.min(1,q.best/55)*3+Math.min(1,q.occ/.45)*2+Math.min(1,hs/Math.max(1,p.h.length))*2;rows.push({x,best:q.best,occ:q.occ,hs})}const L=rows[0],R=rows[10];if(covered<9||L.best<24||L.occ<.20||R.hs<1)continue;score+=covered*2+Math.min(2,R.hs);cands.push({score,left,step,right:left+10*step,covered,rows})}}
 cands.sort((a,b)=>b.score-a.score);if(!cands.length)return{accepted:false,reason:'No bilateral X lattice has enough vertical and horizontal support.'};const top=cands[0],alt=distinct(cands,top),margin=alt?top.score-alt.score:99;if(margin<3.5)return{accepted:false,reason:'Bilateral X lattice is ambiguous.',top,alternative:alt,margin};if(top.left<0||top.right>=img.width||top.right-top.left<img.width*.20)return{accepted:false,reason:'Bilateral X lattice span is implausible.',top,margin};return{accepted:true,...top,margin,alternative:alt}}

function med(a){const b=[...a].sort((x,y)=>x-y),n=b.length;return n?b[n>>1]:NaN}
function groups1d(a,gap=3){if(!a.length)return[];a=[...a].sort((x,y)=>x-y);const out=[];let q=[a[0]];for(let i=1;i<a.length;i++){if(a[i]-a[i-1]<=gap)q.push(a[i]);else{out.push(q);q=[a[i]]}}out.push(q);return out}

function projectionVertical(img){
  const counts=new Int16Array(img.width);
  for(let x=6;x<img.width-6;x++){
    let n=0;for(let y=6;y<img.height-6;y+=2){const i=(y*img.width+x)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))n++}
    counts[x]=n;
  }
  const thr=Math.max(18,img.height*.028),raw=[];
  for(let x=8;x<img.width-8;x++){
    if(counts[x]<thr)continue;
    let mx=counts[x];for(let dx=-3;dx<=3;dx++)mx=Math.max(mx,counts[x+dx]);
    if(counts[x]===mx)raw.push({x,n:counts[x]});
  }
  raw.sort((a,b)=>b.n-a.n);
  const picked=[];
  for(const q of raw){if(picked.every(z=>Math.abs(z.x-q.x)>8))picked.push(q)}
  picked.sort((a,b)=>a.x-b.x);
  let best=null;
  for(let i=0;i<picked.length;i++)for(let j=i+1;j<picked.length;j++){
    const step=picked[j].x-picked[i].x;if(step<35||step>115)continue;
    const hits=[];let strength=0;
    for(let k=0;k<11;k++){
      const t=picked[i].x+k*step,tol=Math.max(5,step*.18);let hit=null;
      for(const z of picked)if(Math.abs(z.x-t)<=tol&&(!hit||Math.abs(z.x-t)<Math.abs(hit.x-t)))hit=z;
      if(hit){hits.push(hit);strength+=hit.n}
    }
    const uniq=[...new Set(hits.map(z=>z.x))],covered=uniq.length;if(covered<8)continue;
    // Refine linear lattice from matched peak index assignments.
    const pairs=[];for(let k=0;k<11;k++){const t=picked[i].x+k*step,tol=Math.max(5,step*.18);let hit=null;
      for(const z of picked)if(Math.abs(z.x-t)<=tol&&(!hit||Math.abs(z.x-t)<Math.abs(hit.x-t)))hit=z;
      if(hit)pairs.push([k,hit.x]);
    }
    const nk=pairs.length,sk=pairs.reduce((a,p)=>a+p[0],0),sx=pairs.reduce((a,p)=>a+p[1],0),
      skk=pairs.reduce((a,p)=>a+p[0]*p[0],0),skx=pairs.reduce((a,p)=>a+p[0]*p[1],0),den=nk*skk-sk*sk;
    const refinedStep=den?((nk*skx-sk*sx)/den):step,refinedLeft=(sx-refinedStep*sk)/nk;
    if(refinedStep<34||refinedStep>116)continue;
    const right=refinedLeft+10*refinedStep;if(refinedLeft<5||right>img.width+refinedStep*.45)continue;
    const rms=Math.sqrt(pairs.reduce((a,p)=>a+(p[1]-(refinedLeft+p[0]*refinedStep))**2,0)/nk);
    if(rms>Math.max(7,refinedStep*.16))continue;
    const score=covered*150+strength*.25-rms*6-refinedLeft*.001;
    if(!best||score>best.score)best={accepted:true,left:refinedLeft,step:refinedStep,right,covered,score,rms,
      xPeaks:picked.map(z=>z.x),peakStrengths:picked.map(z=>z.n)};
  }
  return best||{accepted:false,reason:'projection X lattice unresolved',xPeaks:picked.map(z=>z.x),peakStrengths:picked.map(z=>z.n)};
}
function projectionHorizontal(img,left,right,vStep){
  const x0=Math.max(0,Math.round(left)),x1=Math.min(img.width-1,Math.round(right)),span=Math.max(1,x1-x0+1),ys=[];
  for(let y=6;y<img.height-6;y++){
    let n=0;for(let x=x0;x<=x1;x+=2){const i=(y*img.width+x)*4;if(green(img.data[i],img.data[i+1],img.data[i+2]))n++}
    if(n>=Math.max(18,span*.07))ys.push(y);
  }
  const rows=groups1d(ys,3).map(q=>med(q));
  let best=null;
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)for(let k=j+1;k<rows.length;k++){
    const d1=rows[j]-rows[i],d2=rows[k]-rows[j],m=(d1+d2)/2;if(m<35||m>Math.min(220,(vStep||80)*2.9))continue;
    const cv=Math.abs(d1-d2)/Math.max(1,m);if(cv>.28)continue;
    const seq=[rows[i],rows[j],rows[k]];
    // extend downward/upward if another row follows the same perspective-tolerant spacing.
    let last=rows[k],step=d2;
    for(let z=k+1;z<rows.length&&seq.length<6;z++){const d=rows[z]-last;if(Math.abs(d-step)<=Math.max(8,step*.22)){seq.push(rows[z]);step=d;last=rows[z]}}
    const score=seq.length*120-cv*30-m*.08;
    if(!best||score>best.score)best={accepted:true,rows:seq,step:med(seq.slice(1).map((v,ii)=>v-seq[ii])),score,allRows:rows};
  }
  return best||{accepted:false,reason:'projection Y lattice unresolved',allRows:rows};
}
function projectionPlot(img){
  const vx=projectionVertical(img);if(!vx.accepted)return{accepted:false,reason:vx.reason,vertical:vx};
  const hy=projectionHorizontal(img,vx.left,vx.right,vx.step);if(!hy.accepted)return{accepted:false,reason:hy.reason,vertical:vx,horizontal:hy};
  const h=hy.rows,top=h[0],bottom=h.at(-1),step=vx.step,left=vx.left,right=vx.right;
  const box={left:Math.max(0,Math.round(left-step*3.2)),right:Math.min(img.width-1,Math.round(right+step*.9)),
    top:Math.max(0,Math.round(top-(hy.step||40)*1.5)),bottom:Math.min(img.height-1,Math.round(bottom+(hy.step||40)*2.2))};
  box.w=box.right-box.left+1;box.h=box.bottom-box.top+1;
  return{accepted:true,box,h,v:Array.from({length:11},(_,k)=>left+k*step),hStep:hy.step,vStep:step,left,right,top,bottom,
    score:vx.score+hy.score,source:'projection-green-lattice12',axisRefine:{axisX:left,newStep:step,projection:true},
    geometryGate:{projection:{vertical:vx,horizontal:hy}}};
}

function findPlot(img){try{return Primary.findPlot(img)}catch(primaryError){let p;try{p=Base.findPlot(img)}catch(e){const pr=projectionPlot(img);if(pr.accepted)return pr;throw primaryError}let b=bilateralSolve(img,p),mode='bilateral';const pr=projectionPlot(img);
const xStepDisagree=pr.accepted&&Math.abs(pr.vStep-(p.vStep||pr.vStep))/pr.vStep>.18;
if(pr.accepted&&(!b.accepted&&xStepDisagree))return pr;
if(pr.accepted){
  const oldHs=Number(p.hStep)||0,newHs=Number(pr.hStep)||0,hRatio=oldHs&&newHs?Math.abs(oldHs-newHs)/newHs:0;
  const ph=[...(p.h||[])].sort((a,b)=>a-b),pd=[];for(let i=1;i<ph.length;i++)pd.push(ph[i]-ph[i-1]);
  const pIrregular=pd.length>=2&&(Math.max(...pd)-Math.min(...pd))/Math.max(1,med(pd))>.30;
  const hOverV=oldHs&&Number(p.vStep)?oldHs/Number(p.vStep):0;
  // A photographed compact plot can make the primary detector lock to every
  // minor/half-step row.  Promote the independent long-green major lattice only
  // when its spacing is almost exactly 2x AND at least two primary rows coincide
  // with those major rows.  This is not a global 2x rule.
  const halfStepMatch=ph.length>=5&&oldHs&&newHs&&oldHs/newHs>=.44&&oldHs/newHs<=.56&&pr.h.length>=3&&
    ph.filter(y=>pr.h.some(z=>Math.abs(y-z)<=Math.max(7,oldHs*.18))).length>=2;
  if((!xStepDisagree&&(pIrregular||hOverV>2.8))||halfStepMatch){
    const box={...p.box,top:Math.min(p.box.top,Math.max(0,Math.round(pr.top-pr.hStep))),bottom:Math.max(p.box.bottom,Math.min(img.height-1,Math.round(pr.bottom+pr.hStep)))};
    box.h=box.bottom-box.top+1;
    p={...p,h:pr.h,hStep:pr.hStep,top:pr.top,bottom:pr.bottom,box,source:(p.source||'unknown')+(halfStepMatch?'+projection-major-row-refine13':'+projection-y-refine12'),
      geometryGate:{...(p.geometryGate||{}),projectionY:pr.geometryGate?.projection,halfStepMajorRows:halfStepMatch?{oldRows:ph,oldStep:oldHs,newRows:pr.h,newStep:newHs}:null}};
    // Re-score Sample#0..500 X geometry after fixing the major Y rows.  The minor
    // lattice can make the wrong X phase look strong; the corrected major rows
    // provide the independent intersections needed to recover the data lattice.
    if(halfStepMatch){const rb=bilateralSolve(img,p);if(rb.accepted){b=rb;mode='bilateral';p={...p,geometryGate:{...(p.geometryGate||{}),majorRowXBilateral:rb}}}}
  }
}
if(!b.accepted){const q=intersectionLatticeSolve(img,p);if(q.accepted){b=q;mode='intersection'}else{
  const regular=Array.isArray(p.v)&&p.v.length===11&&Number.isFinite(p.vStep)&&p.vStep>=10&&Array.isArray(p.h)&&p.h.length>=2;
  if(regular){b={accepted:true,left:p.left,right:p.right,step:p.vStep,provisional:true,bilateralRejected:b,intersectionRejected:q};mode='provisional'}
  else{const e=new Error('Needs attention: '+b.reason+' / '+q.reason);e.geometryDiagnostics={primary:primaryError.message,base:p,bilateral:b,intersection:q};throw e}
}}const left=b.left,right=b.right,step=b.step,v=Array.from({length:11},(_,k)=>left+k*step);const box={...p.box,left:Math.max(0,Math.round(left-step*3.2)),right:Math.min(img.width-1,Math.round(right+step*.9))};box.w=box.right-box.left+1;return{...p,left,right,vStep:step,v,box,source:(p.source||'unknown')+(mode==='bilateral'?'+bilateral-fallback11':mode==='intersection'?'+intersection-fallback11':'+provisional-axis-search'),axisRefine:{axisX:left,newStep:step,bilateral:mode==='bilateral',intersection:mode==='intersection',provisional:mode==='provisional'},geometryGate:{...(p.geometryGate||{}),[mode]:b,primaryRejected:primaryError.message}}}}
module.exports={findPlot,bilateralSolve,intersectionLatticeSolve,vstat,projectionPlot,projectionVertical,projectionHorizontal};

},
'core_v2_geometry10_axis_refine.js': function(module,exports,require){
'use strict';
const G=require('./core_v2_geometry9_right_anchor.js');
function green(r,g,b){const m=Math.max(r,b);return g>50&&(g-m)>=8&&g>=m*1.08&&(.299*r+.587*g+.114*b)>30}
function longestRunCol(img,x){const W=img.width,H=img.height,d=img.data;let best=0,cur=0;for(let y=0;y<H;y++){const i=(y*W+x)*4,ok=green(d[i],d[i+1],d[i+2]);cur=ok?cur+1:0;if(cur>best)best=cur}return best}
function refineAxisX(img,plot){const lo=Math.max(0,Math.floor(plot.left-18)),hi=Math.min(img.width-1,Math.ceil(plot.left+10)),r=[];for(let x=lo;x<=hi;x++)r.push({x,run:longestRunCol(img,x)});r.sort((a,b)=>b.run-a.run);if(!r.length||r[0].run<30)throw Error('Needs attention: X=0 vertical axis is not supported by a long green line.');const thr=Math.max(30,r[0].run*.68),xs=r.filter(q=>q.run>=thr).map(q=>q.x).sort((a,b)=>a-b);let groups=[],cur=[];for(const x of xs){if(!cur.length||x-cur.at(-1)<=2)cur.push(x);else{groups.push(cur);cur=[x]}}if(cur.length)groups.push(cur);groups.sort((a,b)=>b.length-a.length);const q=groups[0],axisX=q.reduce((s,x)=>s+x,0)/q.length;return{axisX,bestRun:r[0].run,columns:q}}
function findPlot(img){const p=G.findPlot(img),z=refineAxisX(img,p),oldStep=p.vStep||((p.right-p.left)/10),newStep=(p.right-z.axisX)/10;if(!(newStep>5)||Math.abs(newStep-oldStep)/Math.max(1,oldStep)>.18){const e=Error('Needs attention: X=0 axis line disagrees with the vertical grid lattice.');e.geometryDiagnostics={oldLeft:p.left,axisX:z.axisX,oldStep,newStep,bestRun:z.bestRun};throw e}return{...p,left:z.axisX,vStep:newStep,v:Array.from({length:11},(_,i)=>z.axisX+i*newStep),axisRefine:{oldLeft:p.left,axisX:z.axisX,bestRun:z.bestRun,columns:z.columns,oldStep,newStep}}}
module.exports={findPlot,refineAxisX};

},
'core_v2_geometry9_right_anchor.js': function(module,exports,require){
'use strict';
const prev=require('./core_v2_geometry6.js');
const median=a=>{if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
function green(r,g,b){const mx=Math.max(r,b),lum=.299*r+.587*g+.114*b;return g>42&&(g-mx)>=5&&g>=mx*1.05&&lum>28}
function inferRight(img,p){const d=img.data,W=img.width,H=img.height,x0=Math.max(0,Math.floor(p.box.left)),x1=Math.min(W-1,Math.ceil(p.box.right+p.vStep*7)),rows=[];for(const hy of p.h){const xs=[];for(let y=Math.max(0,Math.round(hy)-1);y<=Math.min(H-1,Math.round(hy)+1);y++)for(let x=x0;x<=x1;x++){const i=(y*W+x)*4;if(green(d[i],d[i+1],d[i+2]))xs.push(x)}if(xs.length>=16){xs.sort((a,b)=>a-b);rows.push(xs[Math.min(xs.length-1,Math.floor(xs.length*.985))])}}if(rows.length<3)return{accepted:false,reason:'X=500 right-edge support is visible on fewer than 3 horizontal grid rows.',rows};const r=median(rows),mad=median(rows.map(x=>Math.abs(x-r))),norm=mad/Math.max(1,p.vStep);if(norm>.62)return{accepted:false,reason:'Horizontal rows disagree on the X=500 right edge.',rows,right:r,mad,norm};return{accepted:true,rows,right:r,mad,norm}}
function findPlot(img){const p=prev.findPlot(img),g=inferRight(img,p);if(!g.accepted){const e=new Error('Needs attention: '+g.reason);e.geometryDiagnostics={source:p.source,rightAnchor:g};throw e}const step=p.vStep,right=g.right,left=right-step*10,v=Array.from({length:11},(_,k)=>left+k*step);if(left<0||right>=img.width||right-left<img.width*.20){const e=new Error('Needs attention: right-anchored X lattice is outside a plausible image span.');e.geometryDiagnostics={source:p.source,rightAnchor:g,left,right,step};throw e}const shift=Math.abs(left-p.left)/Math.max(1,step);if(shift>4.5){const e=new Error('Needs attention: spacing lattice and right-edge anchor disagree too strongly.');e.geometryDiagnostics={source:p.source,rightAnchor:g,left,right,step,shiftSteps:shift};throw e}const box={...p.box,left:Math.max(0,Math.round(left-step*3.2)),right:Math.min(img.width-1,Math.round(right+step*.9))};box.w=box.right-box.left+1;return{...p,v,left,right,vStep:step,box,source:(p.source||'unknown')+'+right-anchor9',geometryGate:{rightAnchor:g,shiftSteps:shift}}}
module.exports={...prev,findPlot,inferRight};

},
'core_v2_geometry6.js': function(module,exports,require){
'use strict';
const prev=require('./core_v2_geometry4.js');
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN;
function green(r,g,b){const mx=Math.max(r,b),lum=.299*r+.587*g+.114*b;return g>34&&(g-mx)>=3.5&&g>=mx*1.035&&lum>22}
function clusterWeighted(indices,scores,gap=3){if(!indices.length)return[];let groups=[],g=[indices[0]];for(let i=1;i<indices.length;i++){if(indices[i]-g[g.length-1]<=gap)g.push(indices[i]);else{groups.push(g);g=[indices[i]]}}groups.push(g);return groups.map(a=>{let sw=0,sx=0;for(const x of a){let w=Math.max(1,scores[x]);sw+=w;sx+=x*w}return Math.round(sx/sw)});}
function regular11(pos,W){let best=null,p=[...pos].sort((a,b)=>a-b);for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){let d=p[j]-p[i];if(d<Math.max(8,W*.035)||d>W*.16)continue;for(let div of [1,2]){let st=d/div;if(st<Math.max(8,W*.03))continue;let origin=p[i],hits=[];for(let k=0;k<11;k++){let t=origin+k*st,near=null,be=1e9;for(const x of p){let e=Math.abs(x-t);if(e<be){be=e;near=x}}if(be<=Math.max(2.5,st*.14))hits.push({k,x:near,e:be});}
 let uniq=[...new Set(hits.map(h=>h.k))];if(uniq.length<7)continue;let first=origin,lines=Array.from({length:11},(_,k)=>first+k*st),center=(lines[0]+lines[10])/2;let score=uniq.length*5-mean(hits.map(h=>h.e))*.7-Math.abs(center-W*.60)/W*2;if(!best||score>best.score)best={step:st,lines,count:uniq.length,score};}}
 return best;}
function findPlotCropLocal(img){
 const W=img.width,H=img.height,d=img.data;if(W<120||H<60)throw Error('crop-local image too small');
 const col=new Float64Array(W);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let i=(y*W+x)*4;if(green(d[i],d[i+1],d[i+2]))col[x]++;}
 let cmax=Math.max(...col),cidx=[];for(let x=0;x<W;x++)if(col[x]>=Math.max(7,cmax*.28))cidx.push(x);
 let xs=clusterWeighted(cidx,col,3),vl=regular11(xs,W);if(!vl)throw Error('crop-local X lattice unresolved');let v=vl.lines;
 // Horizontal grid is measured BETWEEN vertical grid lines. This prevents vertical lines themselves
 // from producing false row support and rejects text/trace populations that do not span cell interiors.
 let mids=[];for(let k=0;k<10;k++)mids.push((v[k]+v[k+1])/2);
 let rs=new Float64Array(H);
 for(let y=0;y<H;y++){
   let n=0;
   for(const mx of mids){let hit=false;for(let dx=-2;dx<=2&&!hit;dx++){let x=Math.max(0,Math.min(W-1,Math.round(mx+dx)));for(let dy=-1;dy<=1;dy++){let yy=Math.max(0,Math.min(H-1,y+dy)),i=(yy*W+x)*4;if(green(d[i],d[i+1],d[i+2])){hit=true;break}}}if(hit)n++;}
   rs[y]=n;
 }
 let ridx=[];for(let y=0;y<H;y++)if(rs[y]>=Math.max(4,Math.ceil(mids.length*.42)))ridx.push(y);
 let ys=clusterWeighted(ridx,rs,3).filter(y=>y<H*.82);
 // Search regular horizontal sequences. Major grid needs at least two rows; prefer more rows and
 // regular spacing, but do not invent a bottom value or require a zero line.
 let best=null;
 for(let i=0;i<ys.length;i++)for(let j=i+1;j<ys.length;j++){
   let st=ys[j]-ys[i];if(st<Math.max(8,H*.045)||st>H*.34)continue;
   let hits=[];for(const y of ys){let k=Math.round((y-ys[i])/st),e=Math.abs(y-(ys[i]+k*st));if(k>=0&&e<=Math.max(2.5,st*.12))hits.push({y,k,e});}
   let ks=[...new Set(hits.map(q=>q.k))].sort((a,b)=>a-b);if(ks.length<2)continue;
   let span=ks[ks.length-1]-ks[0]+1,cov=ks.length/span;if(cov<.55)continue;
   let first=ys[i]+ks[0]*st, last=ys[i]+ks[ks.length-1]*st;
   let lines=Array.from({length:span},(_,z)=>first+z*st);
   let support=hits.reduce((a,q)=>a+rs[Math.max(0,Math.min(H-1,Math.round(q.y)))],0)/hits.length;
   let score=ks.length*7+cov*4+support*.7-mean(hits.map(q=>q.e))*.8;
   if(!best||score>best.score)best={step:st,lines,score,count:ks.length,coverage:cov};
 }
 if(!best)throw Error('crop-local Y lattice unresolved');
 let h=best.lines.filter(y=>y>=0&&y<H*.86);
 let box={left:Math.max(0,Math.round(v[0]-vl.step*2.6)),right:Math.min(W-1,Math.round(v[10]+vl.step*.8)),top:Math.max(0,Math.round(h[0]-best.step*1.15)),bottom:Math.min(H-1,Math.round(h[h.length-1]+best.step*1.35))};box.w=box.right-box.left+1;box.h=box.bottom-box.top+1;
 return{box,h,v,hStep:best.step,vStep:vl.step,left:v[0],right:v[10],top:h[0],bottom:h[h.length-1],score:vl.score+best.score,source:'crop-local-midcell-lattice'};
}
function findPlot(img){try{return prev.findPlot(img)}catch(e){return findPlotCropLocal(img)}}
module.exports={...prev,findPlot,findPlotCropLocal};

},
'core_v2_geometry4.js': function(module,exports,require){
'use strict';
const base=require('./core_v2_geometry3.js');
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN;
function gridGreen(r,g,b){const mx=Math.max(r,b),lum=.299*r+.587*g+.114*b;return g>42&&(g-mx)>=5&&g>=mx*1.05&&lum>28}
function clusters(vals,maxGap=2){if(!vals.length)return[];let o=[],g=[vals[0]];for(let i=1;i<vals.length;i++){if(vals[i]-g[g.length-1]<=maxGap)g.push(vals[i]);else{o.push(Math.round(mean(g)));g=[vals[i]]}}o.push(Math.round(mean(g)));return o}
function regular(pos,minCount,minSpacing,maxSpacing){let best=null,p=[...pos].sort((a,b)=>a-b);for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){let step=p[j]-p[i];if(step<minSpacing||step>maxSpacing)continue;let m=[];for(const x of p){let k=Math.round((x-p[i])/step),e=Math.abs(x-(p[i]+k*step));if(e<=Math.max(2.5,step*.12))m.push({x,k,e})}let ks=[...new Set(m.map(q=>q.k))].sort((a,b)=>a-b);if(ks.length<minCount)continue;let span=ks.at(-1)-ks[0]+1,cov=ks.length/span;if(cov<.62)continue;let first=p[i]+ks[0]*step,score=ks.length*5+cov*4-mean(m.map(q=>q.e));let rec={step,first,lines:Array.from({length:span},(_,z)=>first+z*step),count:ks.length,coverage:cov,score};if(!best||rec.score>best.score)best=rec}return best}
function findPlotStrictGlobal(img){const W=img.width,H=img.height,d=img.data,row=new Int32Array(H),col=new Int32Array(W);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;if(gridGreen(d[i],d[i+1],d[i+2])){row[y]++;col[x]++}}
 const ys=clusters(Array.from({length:H},(_,y)=>y).filter(y=>row[y]>=Math.max(26,W*.055)),3), xs=clusters(Array.from({length:W},(_,x)=>x).filter(x=>col[x]>=Math.max(24,H*.025)),3);const vl=regular(xs,8,Math.max(12,W*.018),W*.13);if(!vl)throw Error('Strict green X-grid unresolved.');let v=vl.lines;while(v.length<11){let r=v.at(-1)+vl.step,l=v[0]-vl.step;if(r<W-2)v.push(r);else if(l>1)v.unshift(l);else break}if(v.length>11)v=v.slice(0,11);
 // Row candidates must show green across a material part of the X-grid span.
 const x0=Math.max(0,Math.floor(v[0])),x1=Math.min(W-1,Math.ceil(v.at(-1))),local=[];for(let y=0;y<H;y++){let n=0;for(let x=x0;x<=x1;x++){const i=(y*W+x)*4;if(gridGreen(d[i],d[i+1],d[i+2]))n++}if(n>=Math.max(24,(x1-x0)*.22))local.push(y)}const hy=clusters(local,3);let bestH=null;for(let i=0;i<hy.length;i++)for(let j=i+1;j<hy.length;j++){let st=hy[j]-hy[i];if(st<10||st>H*.12)continue;let lines=[hy[i]];for(let k=i+1;k<hy.length;k++){let kk=Math.round((hy[k]-hy[i])/st);if(kk>0&&Math.abs(hy[k]-(hy[i]+kk*st))<=Math.max(3,st*.12))lines.push(hy[k])}lines=[...new Set(lines)].sort((a,b)=>a-b);if(lines.length<2)continue; // favor upper valid chart; Energy per Band is above Raw Data in the source UI
 let rec={lines,step:st,top:lines[0],score:lines.length*4-lines[0]/H};if(!bestH||rec.score>bestH.score+.5||(Math.abs(rec.score-bestH.score)<=.5&&rec.top<bestH.top))bestH=rec}
 if(!bestH)throw Error('Strict green Y-grid unresolved.');const h=bestH.lines;const box={left:Math.max(0,Math.round(v[0]-vl.step*3.2)),right:Math.min(W-1,Math.round(v.at(-1)+vl.step*.8)),top:Math.max(0,Math.round(h[0]-bestH.step*1.2)),bottom:Math.min(H-1,Math.round(h.at(-1)+bestH.step*1.8))};box.w=box.right-box.left+1;box.h=box.bottom-box.top+1;return{box,h,v,hStep:bestH.step,vStep:vl.step,left:v[0],right:v.at(-1),top:h[0],bottom:h.at(-1),score:1,source:'strict-global-grid'};}
function findPlot(img){try{return base.findPlot(img)}catch(e){return findPlotStrictGlobal(img)}}
module.exports={...base,findPlot,findPlotStrictGlobal};

},
'core_v2_geometry3.js': function(module,exports,require){
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.EnergyGraphCoreV2=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const median=a=>{if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN;
const mad=a=>{const m=median(a);return median(a.map(v=>Math.abs(v-m)))};
function rgb2hue(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;if(!d)return 0;let h;if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);return(h+360)%360}
function pixStats(r,g,b){const mx=Math.max(r,g,b),mn=Math.min(r,g,b),lum=.299*r+.587*g+.114*b;return{lum,sat:(mx-mn)/Math.max(1,mx),h:rgb2hue(r,g,b)}}
function hueDist(a,b){let d=Math.abs(a-b)%360;return Math.min(d,360-d)}
function greenStrength(r,g,b){return g-Math.max(r,b)}
function isGridGreen(r,g,b){const s=pixStats(r,g,b),m=Math.max(r,b);return g>42&&greenStrength(r,g,b)>=5&&g>=m*1.05&&s.lum>28}
function isAxisGlyph(r,g,b){const s=pixStats(r,g,b);return (g>40&&g>=b*.72&&g>=r*.55&&s.lum>34)||(r>55&&g>50&&b<Math.max(r,g)*.86)||(s.lum>130&&s.sat<.35)}

function makeImage(data,width,height){
  const idx=(x,y)=>(y*width+x)*4;
  return {data,width,height,idx};
}
function longestDarkRun(img,y){const {data,width,idx}=img;let best={len:0,a:0,b:0},a=-1,gap=0;for(let x=0;x<width;x++){const i=idx(x,y),s=pixStats(data[i],data[i+1],data[i+2]),dark=s.lum<105;if(dark){if(a<0)a=x;gap=0}else if(a>=0){gap++;if(gap>4){const b=x-gap,len=b-a+1;if(len>best.len)best={len,a,b};a=-1;gap=0}}}if(a>=0){const len=width-a;if(len>best.len)best={len,a,b:width-1}}return best}
function darkBands(img){const {width,height}=img,minLen=Math.max(100,Math.round(width*.24));const rows=[];for(let y=0;y<height;y++){const r=longestDarkRun(img,y);rows.push(r.len>=minLen?{y,...r}:null)}let groups=[],cur=[];for(let y=0;y<height;y++){if(rows[y])cur.push(rows[y]);else if(cur.length){if(cur.length>=Math.max(20,Math.round(height*.025)))groups.push(cur);cur=[]}}if(cur.length)groups.push(cur);return groups}
function projection(img,box,axis){const {data,idx}=img;const w=box.right-box.left+1,h=box.bottom-box.top+1;if(axis==='h'){const out=new Array(h).fill(0);for(let yy=0;yy<h;yy++){let n=0,c=0;for(let x=box.left+Math.round(w*.08);x<=box.right-Math.round(w*.02);x+=2){const i=idx(x,box.top+yy);n++;if(isGridGreen(data[i],data[i+1],data[i+2]))c++}out[yy]=c/Math.max(1,n)}return out}else{const out=new Array(w).fill(0);for(let xx=0;xx<w;xx++){let n=0,c=0;for(let y=box.top+Math.round(h*.05);y<=box.bottom-Math.round(h*.08);y+=2){const i=idx(box.left+xx,y);n++;if(isGridGreen(data[i],data[i+1],data[i+2]))c++}out[xx]=c/Math.max(1,n)}return out}}
function smooth(a,r=1){return a.map((_,i)=>{let s=0,n=0;for(let k=Math.max(0,i-r);k<=Math.min(a.length-1,i+r);k++){s+=a[k];n++}return s/n})}
function peaks(a,minSep,minVal){const c=[];for(let i=1;i<a.length-1;i++)if(a[i]>=minVal&&a[i]>=a[i-1]&&a[i]>=a[i+1])c.push({i,s:a[i]});c.sort((x,y)=>y.s-x.s);const keep=[];for(const q of c){if(keep.every(p=>Math.abs(p.i-q.i)>=minSep))keep.push(q);if(keep.length>=30)break}return keep.sort((x,y)=>x.i-y.i)}
function fitRegularLattice(pos,minCount,maxCount,minSpacing,maxSpacing){
  let best=null; if(pos.length<minCount)return null;
  const ps=[...pos].sort((a,b)=>a-b);
  const ds=[];for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){const d=(ps[j]-ps[i])/(j-i);if(d>=minSpacing&&d<=maxSpacing)ds.push(d)}
  const cand=[...new Set(ds.map(d=>Math.round(d*2)/2))];
  for(const step of cand){for(const anchor of ps){const matched=[];let err=0;for(const p of ps){const k=Math.round((p-anchor)/step),pred=anchor+k*step,e=Math.abs(p-pred);if(e<=Math.max(2.5,step*.13)){matched.push({p,k,e});err+=e}}const ks=[...new Set(matched.map(m=>m.k))].sort((a,b)=>a-b);if(ks.length<minCount||ks.length>maxCount)continue;const span=ks.at(-1)-ks[0]+1;if(span>maxCount)continue;const coverage=ks.length/span,score=ks.length*4+coverage*5-err/Math.max(1,ks.length)-Math.abs(span-ks.length)*1.5;if(!best||score>best.score){const first=anchor+ks[0]*step;best={step,first,count:span,score,coverage,lines:Array.from({length:span},(_,i)=>first+i*step)}}}}
  return best;
}

function longestGreenRunCol(img,x,top,bottom,maxGap=2){const {data,idx}=img;let best=0,cur=0,gap=0;for(let y=top;y<=bottom;y++){const i=idx(x,y),ok=isGridGreen(data[i],data[i+1],data[i+2]);if(ok){cur+=1+gap;gap=0}else if(cur>0&&gap<maxGap){gap++}else{if(cur>best)best=cur;cur=0;gap=0}}return Math.max(best,cur)}
function cluster1D(a,maxGap=2){if(!a.length)return[];const out=[];let g=[a[0]];for(let i=1;i<a.length;i++){if(a[i]-g[g.length-1]<=maxGap)g.push(a[i]);else{out.push(Math.round(mean(g)));g=[a[i]]}}out.push(Math.round(mean(g)));return out}
function refineVerticalGrid(img,box){const cand=[];const minRun=Math.max(16,box.h*.50);for(let x=box.left;x<=box.right;x++)if(longestGreenRunCol(img,x,box.top,box.bottom,2)>=minRun)cand.push(x);const c=cluster1D(cand,2);let best=null;for(let i=0;i<c.length;i++)for(let j=i+1;j<c.length;j++){const step=c[j]-c[i];if(step<8||step>Math.max(42,box.w*.22))continue;const matched=[];for(const x of c){const k=Math.round((x-c[i])/step),e=Math.abs(x-(c[i]+k*step));if(e<=Math.max(2.5,step*.16))matched.push({x,k,e})}const ks=[...new Set(matched.map(q=>q.k))].sort((a,b)=>a-b);if(ks.length<6)continue;const span=ks[ks.length-1]-ks[0]+1,coverage=ks.length/span;if(coverage<.62)continue;const first=c[i]+ks[0]*step,last=c[i]+ks[ks.length-1]*step,err=mean(matched.map(q=>q.e));const rec={step,first,last,count:ks.length,span,coverage,err,lines:Array.from({length:span},(_,q)=>first+q*step)};if(!best||rec.count>best.count||(rec.count===best.count&&rec.coverage>best.coverage+.03)||(rec.count===best.count&&Math.abs(rec.coverage-best.coverage)<=.03&&rec.first<best.first-1)||(rec.count===best.count&&Math.abs(rec.first-best.first)<=1&&rec.err<best.err))best=rec}return best}

function findPlot(img){
  const cands=[];for(const g of darkBands(img)){const top=g[0].y,bottom=g.at(-1).y,left=Math.round(median(g.map(r=>r.a))),right=Math.round(median(g.map(r=>r.b))),w=right-left+1,h=bottom-top+1;if(w<180||h<55)continue;const box={left,top,right,bottom,w,h};const hp=smooth(projection(img,box,'h')),vp=smooth(projection(img,box,'v'));const hpk=peaks(hp,Math.max(4,Math.round(h*.04)),.05).map(p=>p.i+top),vpk=peaks(vp,Math.max(5,Math.round(w*.025)),.04).map(p=>p.i+left);const hl=fitRegularLattice(hpk,2,8,Math.max(10,h*.08),h*.50),vl=fitRegularLattice(vpk,5,16,Math.max(12,w*.03),w*.20);if(!hl||!vl)continue;let rv=refineVerticalGrid(img,box);const vv=rv&&rv.lines.length>=6?rv.lines:vl.lines;const vs=rv?rv.step:vl.step;if(vv.length<8)continue; const plot={box,h:hl.lines,v:vv,hStep:hl.step,vStep:vs,left:vv[0],right:vv.at(-1),top:hl.lines[0],bottom:hl.lines.at(-1)};const wr=(plot.right-plot.left)/w,hr=(plot.bottom-plot.top)/h;if(wr<.45||hr<.18)continue;const score=hl.score+vl.score+wr*8+hr*5-top/img.height*.5;cands.push({...plot,score})}
  if(!cands.length)throw Error('Energy plot could not be localized safely.');cands.sort((a,b)=>b.score-a.score);return cands[0]
}

const FONT={
'0':["11111","10001","10011","10101","11001","10001","11111"],'1':["00100","01100","00100","00100","00100","00100","01110"],'2':["11110","00001","00001","11110","10000","10000","11111"],'3':["11110","00001","00001","01110","00001","00001","11110"],'4':["10010","10010","10010","11111","00010","00010","00010"],'5':["11111","10000","10000","11110","00001","00001","11110"],'6':["01111","10000","10000","11110","10001","10001","01110"],'7':["11111","00001","00010","00100","01000","01000","01000"],'8':["01110","10001","10001","01110","10001","10001","01110"],'9':["01110","10001","10001","01111","00001","00001","11110"],'.':["0","0","0","0","0","0","1"],'-':["00000","00000","00000","11111","00000","00000","00000"]};
function rasterText(text,gap=1){let glyphs=[];for(const ch of text){const g=FONT[ch];if(g)glyphs.push(g)}const H=7,W=glyphs.reduce((s,g)=>s+g[0].length,0)+gap*Math.max(0,glyphs.length-1),a=new Uint8Array(W*H);let ox=0;for(let gi=0;gi<glyphs.length;gi++){const g=glyphs[gi];for(let y=0;y<H;y++)for(let x=0;x<g[y].length;x++)if(g[y][x]==='1')a[y*W+ox+x]=1;ox+=g[0].length+(gi<glyphs.length-1?gap:0)}return{data:a,w:W,h:H}}
function rowMask(img,plot,y){const {data,idx}=img;const rs=plot.hStep;const x1=Math.round(plot.left-2),x0=Math.max(0,Math.round(plot.left-Math.max((plot.right-plot.left)*.55,plot.hStep*6.5)));const y0=Math.max(plot.box.top,Math.round(y-rs*.45)),y1=Math.min(plot.box.bottom,Math.round(y+rs*.45));if(x1<=x0+8)return{data:new Uint8Array(1),w:1,h:1,x0,y0};const w=x1-x0+1,h=y1-y0+1,a=new Uint8Array(w*h);for(let yy=y0;yy<=y1;yy++)for(let x=x0;x<=x1;x++){if(Math.abs(yy-y)<Math.max(1,rs*.025))continue;const i=idx(x,yy);if(isGridGreen(data[i],data[i+1],data[i+2]))a[(yy-y0)*w+(x-x0)]=1}return{data:a,w,h,x0,y0}}
function scaledTemplate(t,scale){const w=Math.max(1,Math.round(t.w*scale)),h=Math.max(1,Math.round(t.h*scale)),a=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=Math.min(t.w-1,Math.floor(x/scale)),sy=Math.min(t.h-1,Math.floor(y/scale));a[y*w+x]=t.data[sy*t.w+sx]}return{data:a,w,h}}
function scoreTemplateInRow(row,text,plot){let best=0;for(const gap of [1,2]){const base=rasterText(text,gap);for(const sc of [1,1.25,1.5,1.75,2,2.25,2.5,3]){const t=scaledTemplate(base,sc);if(t.h>row.h*.90||t.w>row.w*.98)continue;const yCenter=Math.floor(row.h/2),yMin=Math.max(0,Math.round(yCenter-t.h*.75)),yMax=Math.min(row.h-t.h,Math.round(yCenter-t.h*.25));const xRight=row.w-1;for(let y=yMin;y<=yMax;y++)for(let off=0;off<=Math.min(24,Math.round(plot.hStep*.35));off+=2){const x=xRight-t.w-off;if(x<0)continue;let tp=0,obs=0,tcount=0;for(let yy=0;yy<t.h;yy++)for(let xx=0;xx<t.w;xx++){const tv=t.data[yy*t.w+xx],ov=row.data[(y+yy)*row.w+(x+xx)];if(tv)tcount++;if(ov)obs++;if(tv&&ov)tp++}if(tcount<4)continue;const rec=tp/tcount,prec=tp/Math.max(1,obs),s=rec*.7+prec*.3;if(s>best)best=s}}}return best}

function inferFamilyFromRows(rows){
  const aspects=[];
  for(const row of rows){
    if(row.w<8||row.h<4)continue;
    const cols=new Int16Array(row.w);for(let y=0;y<row.h;y++)for(let x=0;x<row.w;x++)if(row.data[y*row.w+x])cols[x]++;
    const runs=[];let a=-1,g=0;for(let x=0;x<row.w;x++){if(cols[x]){if(a<0)a=x;g=0}else if(a>=0){g++;if(g>Math.max(2,Math.round(row.h*.18))){runs.push([a,x-g]);a=-1;g=0}}}if(a>=0)runs.push([a,row.w-1]);
    if(!runs.length)continue;
    // merge nearby glyph runs into strings, then take group nearest axis (right edge)
    const merged=[];let cur=[...runs[0]];const maxGap=Math.max(5,Math.round(row.h*.55));for(let i=1;i<runs.length;i++){if(runs[i][0]-cur[1]-1<=maxGap)cur[1]=runs[i][1];else{merged.push(cur);cur=[...runs[i]]}}merged.push(cur);
    merged.sort((u,v)=>v[1]-u[1]);const q=merged[0],bw=q[1]-q[0]+1;let ys=[];for(let y=0;y<row.h;y++)for(let x=q[0];x<=q[1];x++)if(row.data[y*row.w+x])ys.push(y);if(!ys.length)continue;const bh=Math.max(...ys)-Math.min(...ys)+1;aspects.push(bw/Math.max(1,bh));
  }
  const a=median(aspects);if(!Number.isFinite(a))return{family:'unknown',aspect:a};if(a>=3.15)return{family:'decimal',aspect:a};if(a<=2.55)return{family:'compact',aspect:a};return{family:'unknown',aspect:a};
}
function axisModels(n){const out=[];const specs=[['decimal',[.0001,.0002,.00025,.0005,.001,.002,.0025,.005,.01,.02]],['compact',[.1,.2,.25,.5,1,2,2.5,5]]];for(const [family,steps] of specs)for(const step of steps){const maxTop=family==='decimal'?.12:30;for(let k=1;k<=Math.ceil(maxTop/step);k++){const top=step*k,bottom=top-step*(n-1);if(bottom<-step*.05||top>maxTop+1e-9)continue;out.push({family,step,top})}}return out}
function fmt(v,f){if(f==='decimal')return Math.abs(v)<5e-8?'0.00000':v.toFixed(5);return v.toFixed(1)}
function solveAxis(img,plot){const rows=plot.h.map(y=>rowMask(img,plot,y));const hint=inferFamilyFromRows(rows);let models=axisModels(rows.length);/* family hint is diagnostic only; do not pre-filter models */const scored=[];for(const m of models){const ss=[];for(let i=0;i<rows.length;i++)ss.push(scoreTemplateInRow(rows[i],fmt(m.top-m.step*i,m.family),plot));const sorted=[...ss].sort((a,b)=>b-a),support=ss.filter(s=>s>=.16).length,top2=(sorted[0]||0)+(sorted[1]||0),avg=mean(ss),score=top2*.55+avg*.45+support*.025;scored.push({...m,score,support,rowScores:ss})}scored.sort((a,b)=>b.score-a.score);const best=scored[0],second=scored[1];if(!best||best.support<2||best.score<.16||!second||best.score-second.score<.0025)throw Error('Y-axis scale is not supported by independent label evidence.');const values=plot.h.map((y,i)=>best.top-best.step*i),slope=-best.step/plot.hStep,intercept=values[0]-slope*plot.h[0];return{...best,values,slope,intercept,margin:best.score-second.score,familyHint:hint}}
function yValue(scale,y){return scale.slope*y+scale.intercept}
function xValue(plot,x){return 500*(x-plot.left)/Math.max(1,plot.right-plot.left)}
function nearGrid(plot,x,y){const ht=Math.max(1.2,plot.hStep*.035),vt=Math.max(1.2,plot.vStep*.025);return plot.h.some(v=>Math.abs(y-v)<=ht)||plot.v.some(v=>Math.abs(x-v)<=vt)}
function foreground(img,plot){
  const {data,idx}=img,bins=new Array(72).fill(0);let white=0;
  for(let y=Math.round(plot.top+2);y<=plot.bottom-2;y++)for(let x=Math.round(plot.left+2);x<=plot.right-2;x++){
    if(nearGrid(plot,x,y))continue;const i=idx(x,y),s=pixStats(data[i],data[i+1],data[i+2]);if(s.lum<35)continue;
    if(s.sat>.18)bins[Math.floor(s.h/5)%72]++; else if(s.lum>145)white++;
  }
  const candidates=bins.map((n,i)=>({mode:'color',hue:i*5+2.5,n})).sort((a,b)=>b.n-a.n).slice(0,10);
  candidates.push({mode:'white',hue:0,n:white});
  const span=Math.max(1,plot.right-plot.left), sampleCols=Math.max(60,Math.min(220,Math.round(span)));
  for(const c of candidates){let hit=0,total=0,ysAll=[];for(let bi=0;bi<sampleCols;bi++){const x=Math.round(plot.left+(bi+.5)/sampleCols*span);let ys=[];for(let y=Math.round(plot.top+1);y<=plot.bottom-1;y++){
      if(nearGrid(plot,x,y))continue;const i=idx(x,y),q=pixStats(data[i],data[i+1],data[i+2]);const ok=c.mode==='white'?(q.sat<.25&&q.lum>125):(q.sat>.10&&q.lum>32&&hueDist(q.h,c.hue)<28);if(ok)ys.push(y);
    } if(ys.length){hit++;total+=Math.min(6,ys.length);ysAll.push(median(ys));}}
    const coverage=hit/sampleCols, abundance=total/sampleCols; const yspread=ysAll.length?mad(ysAll)/(Math.max(1,plot.bottom-plot.top)):1;
    c.coverage=coverage;c.score=coverage*5+Math.min(2,abundance*.22)-Math.min(.8,yspread*.25)+Math.log1p(c.n)*.025;
  }
  candidates.sort((a,b)=>b.score-a.score);return candidates[0]||{mode:'color',hue:120};
}
function isTrace(img,plot,x,y,fm){const {data,idx}=img,i=idx(x,y),s=pixStats(data[i],data[i+1],data[i+2]);let ok=fm.mode==='white'?(s.sat<.22&&s.lum>135):(s.sat>.12&&s.lum>38&&hueDist(s.h,fm.hue)<40);if(!ok)return false;if(!nearGrid(plot,x,y))return true;let c=0;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){if(!dx&&!dy)continue;const X=clamp(x+dx,0,img.width-1),Y=clamp(y+dy,0,img.height-1),j=idx(X,Y),q=pixStats(data[j],data[j+1],data[j+2]);if(fm.mode==='white'?(q.sat<.25&&q.lum>120):(q.sat>.10&&q.lum>32&&hueDist(q.h,fm.hue)<45))c++}return c>=4}
function extractTrace(img,plot,scale){const fm=foreground(img,plot),pts=[],span=plot.right-plot.left,bins=Math.max(140,Math.min(500,Math.round(span)));for(let bi=0;bi<bins;bi++){const x=Math.round(plot.left+(bi+.5)/bins*span),ys=[];for(let y=Math.round(plot.top+1);y<=plot.bottom-1;y++)if(isTrace(img,plot,x,y,fm))ys.push(y);if(!ys.length)continue;const vals=ys.map(y=>yValue(scale,y));const med=median(vals),M=mad(vals)||Math.abs(scale.step)*.08,keep=vals.filter(v=>Math.abs(v-med)<=Math.max(M*4,Math.abs(scale.step)*.65));if(keep.length)pts.push({x,y:median(ys),value:mean(keep),support:keep.length})}if(pts.length<12)throw Error('Foreground trace could not be isolated inside Energy plot.');return{fm,points:pts}}
function robustMean(vals){if(vals.length<3)return mean(vals);const m=median(vals),M=mad(vals)||1e-12,keep=vals.filter(v=>Math.abs(v-m)<=Math.max(M*4,Math.abs(m)*.35+1e-9));return mean(keep.length>=3?keep:vals)}
function rangeMean(plot,trace,a,b){const v=trace.points.filter(p=>{const x=xValue(plot,p.x);return x>=a&&x<=b}).map(p=>p.value);if(v.length<3)throw Error(`Not enough trace samples in ${a===0?'Low':'High'} range.`);return{mean:robustMean(v),count:v.length}}
function analyzeRGBA(input){const img=makeImage(input.data,input.width,input.height),plot=findPlot(img),scale=solveAxis(img,plot),trace=extractTrace(img,plot,scale),low=rangeMean(plot,trace,0,260),high=rangeMean(plot,trace,270,500);const min=Math.min(...scale.values)-scale.step*.35,max=Math.max(...scale.values)+scale.step*.35;if(low.mean<min||low.mean>max||high.mean<min||high.mean>max)throw Error('Computed mean contradicts visible Y-axis range.');return{plot,scale,trace,low,high,version:'2.0.0'}}
return{analyzeRGBA,findPlot,solveAxis,extractTrace};
});

},
'core_v2_axis_resolver51_empirical_offset.js': function(module,exports,require){
'use strict';
const Base=require('./core_v2_axis_resolver50_fast_safe.js');
const C=require('./core_v2_axis_gui_candidate9_memo.js');
const E=require('./core_v2_empirical_numeric_evidence.js');
const AX=require('./core_v2_axis_consensus2.js');
const Compact=require('./core_v2_axis_resolver49_broken_rank_evidence.js');
const CompactEvidence=require('./core_v2_compact_empirical_evidence.js');
const Glyph=require('./core_v2_axis_glyph_candidate4_preserve_strokes.js');
const Geometry=require('./core_v2_geometry11_bilateral_fallback.js');
const VIEWS=[{gmin:46,diff:6,ratio:1.06,lum:28},{gmin:50,diff:8,ratio:1.08,lum:30},{gmin:52,diff:8,ratio:1.08,lum:30}];
function text(v){return(Math.abs(v)<5e-10?0:v).toFixed(5)}
function sameTwoRows(d){const rows=d?.rows,steps=d?.step,xs=d?.axisX;if(!Array.isArray(rows)||rows.length!==3||rows.some(r=>!Array.isArray(r)||r.length!==2))return false;for(let v=1;v<3;v++)for(let i=0;i<2;i++)if(Math.abs(rows[v][i]-rows[0][i])>1)return false;if(!Array.isArray(steps)||steps.some(s=>!(s>0))||Math.max(...steps)-Math.min(...steps)>Math.max(...steps)*.02)return false;if(!Array.isArray(xs)||xs.some(x=>!Number.isFinite(x))||Math.max(...xs)-Math.min(...xs)>1.25)return false;return true}
function rescue(img,plot,base){const d=base?.diagnostics;if(base.accepted||base.reason!=='axis hypothesis margin too small'||!sameTwoRows(d))return null;const step=d.step.reduce((a,b)=>a+b,0)/3,rows=d.rows[0],axisX=d.axisX.reduce((a,b)=>a+b,0)/3;if(!(step>0))return null;const labelVals=Object.keys(E.BANK.labels).map(Number).filter(Number.isFinite).sort((a,b)=>b-a),pairs=[];for(const top of labelVals){const bot=top-step;if(bot<0)continue;const a=text(top),b=text(bot);if(!E.BANK.labels[a]||!E.BANK.labels[b])continue;if(VIEWS.some((_,vi)=>E.independentSources(a,vi)<2||E.independentSources(b,vi)<2))continue;pairs.push({top,bot,texts:[a,b]})}if(pairs.length<2)return null;const viewResults=[];for(let vi=0;vi<3;vi++){const v=VIEWS[vi],p={...plot,left:axisX},rowStep=rows[1]-rows[0],masks=rows.map(y=>C.rowMask(img,p,y,rowStep,v)),scored=[];for(const q of pairs){const ss=q.texts.map((t,i)=>E.scoreRow(masks[i],t,vi));if(ss.some(x=>x==null))continue;scored.push({...q,rowScores:ss,score:ss[0]+ss[1]})}scored.sort((a,b)=>b.score-a.score);if(scored.length<2)return null;const best=scored[0],second=scored[1],margin=best.score-second.score;if(!(best.score>=.84&&margin>=.12&&best.rowScores.every(s=>s>=.34)))return null;viewResults.push({best,second,margin})}
const key=q=>q.texts.join('|');if(new Set(viewResults.map(v=>key(v.best))).size!==1)return null;const q=viewResults[0].best,anchors=rows.map((y,i)=>({y,value:i?q.bot:q.top,text:q.texts[i],conf:Math.min(...viewResults.map(v=>v.best.rowScores[i]))})),fit=AX.fitAffine(anchors);if(!(fit.slope<0)||fit.rmse/step>.03)return null;return{accepted:true,rows,values:[q.top,q.bot],slope:fit.slope,intercept:fit.intercept,step,normRmse:fit.rmse/step,spacingCv:0,views:3,worstValueSteps:0,worstStepLogRatio:0,diagnostics:{...(d||{}),mode:'v51-empirical-independent-offset',empiricalRescue:true,empirical:viewResults.map(v=>({best:v.best.texts,score:v.best.score,rowScores:v.best.rowScores,second:v.second.texts,secondScore:v.second.score,margin:v.margin}))}}}


function median(a){const b=[...a].sort((x,y)=>x-y),n=b.length;return n?b[n>>1]:NaN}
function decimalPatterns(){
  const vals=Object.keys(E.BANK.labels).map(Number).filter(v=>Number.isFinite(v)&&v>0&&v<=.1).sort((a,b)=>b-a);
  const out=[];
  for(let n=2;n<=4;n++){
    for(const top of vals)for(const step of vals.map(v=>Math.abs(top-v)).filter(x=>x>0&&x<=.02)){
      const seq=Array.from({length:n},(_,i)=>+(top-i*step).toFixed(5));
      if(seq.some(v=>v<=0))continue;
      const texts=seq.map(text);
      if(texts.some(t=>!E.BANK.labels[t]))continue;
      if(texts.some(t=>VIEWS.some((_,vi)=>E.independentSources(t,vi)<2)))continue;
      const key=texts.join('|');
      if(!out.some(q=>q.key===key))out.push({key,values:seq,texts,step});
    }
  }
  return out;
}
function extendedRows(plot){
  const hs=[...(plot.h||[])].filter(Number.isFinite).sort((a,b)=>a-b);
  if(hs.length<1)return[];
  const dif=[];for(let i=1;i<hs.length;i++)if(hs[i]-hs[i-1]>8)dif.push(hs[i]-hs[i-1]);
  const step=Number.isFinite(plot.hStep)&&plot.hStep>8?plot.hStep:(dif.length?median(dif):NaN);
  if(!(step>8))return hs;
  const lo=Math.max(12,hs[0]-2*step),hi=Math.min(imgHeightHint(plot),hs.at(-1)+2*step);
  const rows=[];
  for(let k=-2;k<=hs.length+1;k++)rows.push(hs[0]+k*step);
  for(const y of hs)rows.push(y);
  return [...new Set(rows.map(y=>Math.round(y*2)/2))].filter(y=>y>=lo-1&&y<=hi+1).sort((a,b)=>a-b);
}
function imgHeightHint(plot){return Number.isFinite(plot?.box?.bottom)?Math.max(plot.box.bottom+Math.max(40,plot.hStep||0)*2,plot.box.bottom):2000}

function maskAspect(m){
  let x0=m.w,y0=m.h,x1=-1,y1=-1;
  for(let y=0;y<m.h;y++)for(let x=0;x<m.w;x++)if(m.data[y*m.w+x]){
    x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
  }
  return x1<0?0:(x1-x0+1)/Math.max(1,y1-y0+1);
}


function decimalZeroBaselineSearch(img,plot){
  const hs0=[...(plot.h||[])].filter(Number.isFinite).sort((a,b)=>a-b);
  if(hs0.length<2||!Number.isFinite(plot.vStep))return null;
  const dif=[];for(let i=1;i<hs0.length;i++)if(hs0[i]-hs0[i-1]>8)dif.push(hs0[i]-hs0[i-1]);
  const rowStep=Number.isFinite(plot.hStep)&&plot.hStep>8?plot.hStep:(dif.length?median(dif):NaN);
  if(!(rowStep>8))return null;
  const rows=[];for(let k=-2;k<=hs0.length+1;k++)rows.push(hs0[0]+k*rowStep);for(const y of hs0)rows.push(y);
  const ext=[...new Set(rows.map(y=>Math.round(y*2)/2))].filter(y=>y>10&&y<img.height-10).sort((a,b)=>a-b);
  const vals=Object.keys(E.BANK.labels).map(Number).filter(v=>Number.isFinite(v)&&v>0&&v<=.1);
  const steps=[...new Set(vals.map(v=>+v.toFixed(5)))].filter(step=>{
    return E.BANK.labels[text(step)]&&E.BANK.labels[text(2*step)]&&E.BANK.labels[text(3*step)] &&
      VIEWS.every((_,vi)=>E.independentSources(text(step),vi)>=2&&E.independentSources(text(2*step),vi)>=2&&E.independentSources(text(3*step),vi)>=2);
  });
  const offsets=[0,-.25,.25,-.5,.5,-.75,.75,-1,1,-1.25,1.25,-1.5,1.5],cand=[];
  for(const off of offsets){
    const axisX=plot.left+off*plot.vStep;if(axisX<55||axisX>=img.width-10)continue;
    const p={...plot,left:axisX};
    for(const step of steps){
      const q=[3*step,2*step,step].map(v=>+v.toFixed(5)),texts=q.map(text);
      for(let j=0;j+2<ext.length;j++){
        const rr=ext.slice(j,j+3);
        if(rr.slice(1).some((y,i)=>Math.abs((y-rr[i])-rowStep)>Math.max(2,rowStep*.08)))continue;
        const zeroRow=rr[2]+rowStep;if(zeroRow>=img.height-8)continue;
        const per=[];
        for(let vi=0;vi<3;vi++){
          const ss=[];let vok=true;
          for(let i=0;i<3;i++){
            const m=C.rowMask(img,p,rr[i],rowStep,VIEWS[vi]),asp=maskAspect(m),z=E.scoreRow(m,texts[i],vi);
            if(asp<2.20||z==null){vok=false;break}ss.push(z);
          }
          if(vok)per.push(ss);
        }
        if(per.length<2)continue;
        const all=per.flat(),minRow=Math.min(...all),mean=all.reduce((a,b)=>a+b,0)/all.length;
        if(minRow<.28||mean<.40)continue;
        // The inferred zero must coincide with the next horizontal lattice row.
        const zeroSupported=hs0.some(h=>Math.abs(h-zeroRow)<=Math.max(2,rowStep*.08));
        if(!zeroSupported)continue;
        // A zero-baseline row must not itself contain a long five-decimal numeric label.
        // This prevents 0.04000/0.03000/0.02000/0.01000 from being shifted down to 0.03/0.02/0.01/0.
        let zeroLong=0;
        for(let vi=0;vi<3;vi++){
          const zm=C.rowMask(img,p,zeroRow,rowStep,VIEWS[vi]);
          if(maskAspect(zm)>=2.20)zeroLong++;
        }
        if(zeroLong>=2)continue;
        const anchors=[...rr.map((y,i)=>({y,value:q[i],text:texts[i],conf:Math.min(...per.map(v=>v[i]))})),{y:zeroRow,value:0,text:'0.00000',conf:1}];
        const fit=AX.fitAffine(anchors);if(!(fit.slope<0))continue;
        const norm=fit.rmse/Math.max(step,1e-12);if(norm>.03)continue;
        cand.push({score:mean+minRow*.08,mean,minRow,axisX,rows:[...rr,zeroRow],values:[...q,0],step,fit,norm,texts,views:per.length});
      }
    }
  }
  cand.sort((a,b)=>b.score-a.score);if(!cand.length)return null;
  const b=cand[0],alt=cand.find(c=>c.values.join('|')!==b.values.join('|'));
  if(alt&&b.score-alt.score<.06)return null;
  return {accepted:true,rows:b.rows,values:b.values,slope:b.fit.slope,intercept:b.fit.intercept,step:b.step,normRmse:b.norm,
    spacingCv:0,views:b.views,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'v57-decimal-zero-baseline-2of3',axisX:b.axisX,score:b.score,empiricalMean:b.mean,minRow:b.minRow,
      labels:b.texts,rows:b.rows,inferredRows:[b.rows[3]],zeroBaseline:true}};
}

function decimalSearch(img,plot,base){
  const hs0=[...(plot.h||[])].filter(Number.isFinite).sort((a,b)=>a-b);
  if(hs0.length<1||!Number.isFinite(plot.vStep))return null;
  const dif=[];for(let i=1;i<hs0.length;i++)if(hs0[i]-hs0[i-1]>8)dif.push(hs0[i]-hs0[i-1]);
  const rowStep=Number.isFinite(plot.hStep)&&plot.hStep>8?plot.hStep:(dif.length?median(dif):NaN);
  if(!(rowStep>8))return null;
  const rows=[];
  for(let k=-2;k<=hs0.length+1;k++)rows.push(hs0[0]+k*rowStep);
  for(const y of hs0)rows.push(y);
  const ext=[...new Set(rows.map(y=>Math.round(y*2)/2))]
    .filter(y=>y>10&&y<img.height-10).sort((a,b)=>a-b);
  const patterns=decimalPatterns();if(!patterns.length)return null;
  const offsets=[0,-.25,.25,-.5,.5,-.75,.75,-1,1,-1.25,1.25,-1.5,1.5];
  const candidates=[];
  for(const off of offsets){
    const axisX=plot.left+off*plot.vStep;if(axisX<55||axisX>=img.width-10)continue;
    const p={...plot,left:axisX};
    for(const q of patterns){
      const n=q.values.length;
      for(let j=0;j+n<=ext.length;j++){
        const rr=ext.slice(j,j+n);
        // rows must be one regular lattice step apart
        if(rr.slice(1).some((y,i)=>Math.abs((y-rr[i])-rowStep)>Math.max(2,rowStep*.08)))continue;
        const perView=[];
        for(let vi=0;vi<3;vi++){
          const ss=[];let vok=true;
          for(let i=0;i<n;i++){
            const m=C.rowMask(img,p,rr[i],rowStep,VIEWS[vi]),asp=maskAspect(m),z=E.scoreRow(m,q.texts[i],vi);
            if(asp<2.20||z==null){vok=false;break}ss.push(z);
          }
          if(vok)perView.push(ss);
        }
        if(perView.length<2)continue;
        const all=perView.flat(),minRow=Math.min(...all),meanScore=all.reduce((a,b)=>a+b,0)/all.length;
        const minReq=n>=4?.25:n===3?.28:.34,meanReq=n>=4?.36:n===3?.40:.48;
        if(minRow<minReq||meanScore<meanReq)continue;
        const anchors=rr.map((y,i)=>({y,value:q.values[i],text:q.texts[i],conf:Math.min(...perView.map(v=>v[i]))}));
        const fit=AX.fitAffine(anchors);if(!(fit.slope<0))continue;
        const norm=fit.rmse/Math.max(q.step,1e-12);if(norm>.055)continue;
        // favor longer fully-supported label sequences, then empirical score
        const inferredBelow=rr.filter(y=>y>hs0.at(-1)+2).length,inferredAbove=rr.filter(y=>y<hs0[0]-2).length;
        const missingEdgePenalty=n>=3?(inferredBelow*.15+inferredAbove*.02):0;
        const score=meanScore+n*.09-minRow*.02-norm*.5-missingEdgePenalty;
        candidates.push({score,meanScore,minRow,axisX,rows:rr,q,anchors,fit,norm,perView,views:perView.length});
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(!candidates.length)return null;
  const top0=candidates[0],eligible=candidates.filter(c=>c.q.values.length===top0.q.values.length);
  eligible.sort((a,b)=>b.score-a.score);
  const top=eligible[0];
  const altPattern=eligible.find(c=>c.q.key!==top.q.key);
  if(altPattern&&top.score-altPattern.score<.055)return null;
  // When the numeric sequence and rows agree, X=0 ambiguity is geometric rather than numeric.
  // Choose the near-top candidate closest to the geometry X=0 instead of rejecting the Y scale.
  const same=eligible.filter(c=>c.q.key===top.q.key&&c.rows.join('|')===top.rows.join('|')&&c.score>=top.score-.04);
  same.sort((a,b)=>Math.abs(a.axisX-plot.left)-Math.abs(b.axisX-plot.left));
  const best=same[0]||top;
  // two-label solutions need a stronger competing-numeric-hypothesis margin.
  if(best.q.values.length===2&&altPattern&&top.score-altPattern.score<.10)return null;
  return{
    accepted:true,rows:best.rows,values:best.q.values,slope:best.fit.slope,intercept:best.fit.intercept,
    step:best.q.step,normRmse:best.norm,spacingCv:0,views:best.views,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'v58-general-decimal-affine-2of3',fiveDecimalRescue:true,axisX:best.axisX,score:best.score,
      empiricalMean:best.meanScore,minRow:best.minRow,labels:best.q.texts,rows:best.rows,
      inferredRows:best.rows.filter(y=>!hs0.some(h=>Math.abs(h-y)<=2)),
      alternative:altPattern?{labels:altPattern.q.texts,score:altPattern.score}:null}
  };
}


function strictGreen(r,g,b){
  const m=Math.max(r,b),lum=.299*r+.587*g+.114*b;
  return g>46&&(g-m)>=6&&g>=m*1.06&&lum>28;
}
function cluster1d(vals,gap=3){
  if(!vals.length)return[];
  vals=[...vals].sort((a,b)=>a-b);const out=[];let cur=[vals[0]];
  for(let i=1;i<vals.length;i++){
    if(vals[i]-vals[i-1]<=gap)cur.push(vals[i]);else{out.push(cur);cur=[vals[i]]}
  }
  out.push(cur);return out;
}
function horizontalGreenRows(img,plot){
  const x0=Math.max(0,Math.round(Math.min(plot.left,plot.right)-Math.abs(plot.vStep||50)*.5)),
        x1=Math.min(img.width-1,Math.round(Math.max(plot.left,plot.right)));
  const span=Math.max(1,x1-x0+1),ys=[];
  for(let y=8;y<img.height-8;y++){
    let n=0;for(let x=x0;x<=x1;x+=2){const i=(y*img.width+x)*4;if(strictGreen(img.data[i],img.data[i+1],img.data[i+2]))n++}
    if(n/Math.ceil(span/2)>=.18)ys.push(y);
  }
  return cluster1d(ys,3).map(q=>median(q)).filter(Number.isFinite);
}
function bestRegularRows(rows){
  if(rows.length<2)return null;let best=null;
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const st=rows[j]-rows[i];if(st<24||st>220)continue;
    const seq=[];
    for(let k=0;k<8;k++){
      const t=rows[i]+k*st,r=rows.reduce((a,b)=>Math.abs(b-t)<Math.abs(a-t)?b:a,rows[0]);
      if(Math.abs(r-t)<=Math.max(3,st*.08))seq.push(r);else if(k>1)break;
    }
    const u=[...new Set(seq)];
    if(u.length<2)continue;
    const score=u.length*10-Math.abs(st-(Number.isFinite(this?.hStep)?this.hStep:st));
    if(!best||score>best.score)best={rows:u,step:st,score};
  }
  return best;
}
function verticalAxisFromRows(img,rows,rowStep,plot){
  if(rows.length<2)return null;
  const y0=Math.max(0,Math.round(rows[0]-rowStep*.25)),y1=Math.min(img.height-1,Math.round(rows.at(-1)+rowStep*.25)),cand=[];
  for(let x=10;x<img.width-10;x++){
    let n=0,total=0;
    for(let y=y0;y<=y1;y+=2){total++;const i=(y*img.width+x)*4;if(strictGreen(img.data[i],img.data[i+1],img.data[i+2]))n++}
    if(n/Math.max(1,total)>.34)cand.push(x);
  }
  const xs=cluster1d(cand,3).map(q=>median(q)).filter(Number.isFinite);
  if(!xs.length)return null;
  const st0=Math.abs(plot.vStep||0);
  let best=null;
  for(const x of xs){
    let n=1,step=st0;
    if(st0>10){for(let k=1;k<11;k++){const t=x+k*st0;if(xs.some(z=>Math.abs(z-t)<=Math.max(3,st0*.08)))n++}}
    else{
      const ds=xs.filter(z=>z>x+20).map(z=>z-x);if(ds.length)step=Math.min(...ds);
      if(step>10)for(let k=1;k<11;k++)if(xs.some(z=>Math.abs(z-(x+k*step))<=Math.max(3,step*.08)))n++;
    }
    const closeness=Math.abs(x-plot.left)/Math.max(1,st0||step||50),score=n*5-closeness;
    if(n>=5&&(!best||score>best.score))best={x,step:st0||step,n,score};
  }
  return best;
}
function labelSpanAt(img,axisX,y,rowStep){
  const x0=Math.max(0,Math.round(axisX-190)),x1=Math.max(x0,Math.round(axisX-4)),
        y0=Math.max(0,Math.round(y-rowStep*.28)),y1=Math.min(img.height-1,Math.round(y+rowStep*.28)),cols=[];
  for(let x=x0;x<=x1;x++){
    let hit=false;for(let yy=y0;yy<=y1&&!hit;yy++){const i=(yy*img.width+x)*4;if(strictGreen(img.data[i],img.data[i+1],img.data[i+2]))hit=true}
    if(hit)cols.push(x);
  }
  const groups=cluster1d(cols,5).filter(q=>q.length>=2);
  if(!groups.length)return{width:0,x0:null,x1:null};
  // take the rightmost text group nearest the Y axis; merge nearby character groups.
  let g=groups.at(-1),lo=g[0],hi=g.at(-1);
  for(let i=groups.length-2;i>=0;i--){if(lo-groups[i].at(-1)<=9){lo=groups[i][0]}else break}
  return{width:hi-lo+1,x0:lo,x1:hi};
}
function twoDecimalHypothesis(img,plot,rows,rowStep,axisX){
  const scoreStep=Math.min(rowStep,Math.max(36,(Number(plot.vStep)||50)*1.35));
  const hyps=[
    {values:[.02,.01],texts:['0.02000','0.01000'],step:.01},
    {values:[.01,.005],texts:['0.01000','0.00500'],step:.005}
  ],out=[];
  for(const h of hyps){
    const per=[];
    for(let vi=0;vi<3;vi++){
      const ss=[];let ok=true;
      for(let i=0;i<2;i++){
        const m=C.rowMask(img,{...plot,left:axisX},rows[i],scoreStep,VIEWS[vi]),z=E.scoreRow(m,h.texts[i],vi);
        if(z==null){ok=false;break}ss.push(z);
      }
      if(ok)per.push(ss);
    }
    if(per.length<2)continue;
    const all=per.flat(),mean=all.reduce((a,b)=>a+b,0)/all.length,min=Math.min(...all);
    out.push({...h,mean,min,views:per.length});
  }
  out.sort((a,b)=>b.mean-a.mean);if(!out.length)return null;
  let best=out[0];
  if(out.length>1&&best.mean-out[1].mean<.035){
    const alt=out[1];
    // dev37 reconstruction: when both decimal families explain the same two
    // physical green rows, shared zero glyphs must not choose the family.
    // Compare the discriminating top label with glyph-level evidence and then
    // independently confirm the expected lower label.  This changes only the
    // family attached to the measured rows; it introduces no value coefficient.
    const gh=(h,k)=>{let z=0,n=0;for(let vi=0;vi<3;vi++){const row=Glyph.rowMask(img,{...plot,left:axisX},rows[k],scoreStep,VIEWS[vi]),d=Glyph.fixedDetail(row,h.texts[k],'0.00000')||Glyph.detail(row,h.texts[k]);if(d){z+=d.score+.18*(d.charMean||0);n++}}return n?z/n:0};
    const topBest=gh(best,0),topAlt=gh(alt,0),bottomBest=gh(best,1),bottomAlt=gh(alt,1);
    const topMargin=topBest-topAlt,bottomMargin=best.mean-alt.mean;
    if(topMargin<=-.025&&alt.mean>=.30&&alt.min>=.28&&bottomAlt>=.70)best=alt;
    else if(!(topMargin>=.025&&best.mean>=.30&&best.min>=.28&&bottomBest>=.70))return null;
  }
  if(best.mean<.34||best.min<.20)return null;
  return best;
}

function candidateAxisRows(plot,img){
  let rows=[...(plot.h||[])].filter(Number.isFinite).sort((a,b)=>a-b),step=Number(plot.hStep)||NaN;
  if(!(step>=24&&step<=220)||rows.length<2){
    const raw=horizontalGreenRows(img,plot),lat=bestRegularRows(raw);if(lat){rows=lat.rows;step=lat.step}
  }
  if(!(step>=24&&step<=220)||rows.length<2)return null;
  // add one inferred neighbor around each edge; inference is only for label search, never a value assumption.
  const ext=[...rows];
  for(const y of [rows[0]-step,rows.at(-1)+step])if(y>8&&y<img.height-8)ext.push(y);
  return{rows:[...new Set(ext.map(y=>Math.round(y)))].sort((a,b)=>a-b),step};
}

function projectionPhaseCompactFallback(img,plot){
  if(!Array.isArray(plot.h)||plot.h.length!==3)return null;
  const pv=Geometry.projectionVertical(img);if(!pv?.accepted||!(pv.step>20))return null;
  const cands=[];
  for(let k=-2;k<=3;k++){
    const axisX=pv.left+k*pv.step;if(axisX<40||axisX>=img.width-40)continue;
    const right=axisX+10*pv.step;if(right>img.width+pv.step*.35)continue;
    const pp={...plot,left:axisX,right,vStep:pv.step,v:Array.from({length:11},(_,i)=>axisX+i*pv.step)};
    const q=Compact.compactAt(img,pp,{disableFast:true});if(!q)continue;
    const mean=Number(q.empiricalMean)||0,min=Number(q.empiricalMin)||0;
    if(mean<.54||min<.48)continue;
    const phasePenalty=Math.abs(k)*.012,score=mean+min*.20-phasePenalty;
    cands.push({q,pp,k,score});
  }
  cands.sort((a,b)=>b.score-a.score);if(!cands.length)return null;
  if(cands.length>1&&cands[0].score-cands[1].score<.018)return null;
  const b=cands[0],q=b.q;
  return{...q,rows:[...plot.h],values:[3,2,1],step:1,
    diagnostics:{...(q.diagnostics||{}),mode:'v65-compact-projection-phase',compact:true,verifiedUnitStep:true,
      axisX:b.pp.left,projectionLeft:pv.left,projectionStep:pv.step,phase:b.k,empiricalMean:q.empiricalMean,empiricalMin:q.empiricalMin}};
}

function compactEmpiricalFallback(img,plot){
  const q=candidateAxisRows(plot,img);if(!q)return null;const cands=[];
  for(let i=0;i+2<q.rows.length;i++){
    const rr=q.rows.slice(i,i+3),d1=rr[1]-rr[0],d2=rr[2]-rr[1],st=(d1+d2)/2;
    if(Math.abs(d1-d2)>Math.max(8,st*.16))continue;
    for(const off of [0,-.12,.12,.5,1,1.5,2,-.5,-1]){
      const axisX=plot.left+off*(plot.vStep||50),per=[];let ok=true;
      for(let vi=0;vi<3;vi++){
        const ss=[];for(let k=0;k<3;k++){
          const row=Glyph.rowMask(img,{...plot,left:axisX},rr[k],st,VIEWS[vi]),z=CompactEvidence.scoreRow(row,['3.0','2.0','1.0'][k],vi);
          if(z==null){ok=false;break}ss.push(z);
        }if(ok)per.push(ss);ok=true;
      }
      if(per.length<3)continue;const all=per.flat(),mean=all.reduce((a,b)=>a+b,0)/all.length,min=Math.min(...all);
      if(mean<.50||min<.42)continue;
      const anchors=rr.map((y,k)=>({y,value:3-k,text:(3-k).toFixed(1),conf:Math.min(...per.map(v=>v[k]))})),fit=AX.fitAffine(anchors);
      if(!(fit.slope<0)||fit.rmse>.06)continue;
      const score=mean+min*.18-Math.abs(off)*.03;cands.push({score,mean,min,axisX,rr,fit,per});
    }
  }
  cands.sort((a,b)=>b.score-a.score);if(!cands.length)return null;const b=cands[0];if(cands[1]&&b.score-cands[1].score<.004&&b.rr.join('|')!==cands[1].rr.join('|'))return null;
  return{accepted:true,rows:b.rr,values:[3,2,1],slope:b.fit.slope,intercept:b.fit.intercept,step:1,normRmse:b.fit.rmse,spacingCv:0,views:3,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'v62-compact-empirical-series',compact:true,verifiedUnitStep:true,axisX:b.axisX,empiricalMean:b.mean,empiricalMin:b.min,latticeRows:q.rows}};
}


function compactLabelPeakFallback(img,plot){
  if(!Number.isFinite(plot.left)||!Number.isFinite(plot.vStep)||plot.vStep<20)return null;
  const axisX=plot.left,x0=Math.max(0,Math.round(axisX-plot.vStep*1.15)),x1=Math.max(x0,Math.round(axisX-4)),w=x1-x0+1;
  const counts=[];
  for(let y=8;y<img.height-8;y++){
    let n=0;for(let x=x0;x<=x1;x++){const i=(y*img.width+x)*4;if(C.green(img.data[i],img.data[i+1],img.data[i+2],VIEWS[1]))n++}
    counts.push({y,n});
  }
  const thr=Math.max(6,Math.round(w*.16)),active=counts.filter(q=>q.n>=thr),bands=[];let cur=[];
  for(const q of active){if(!cur.length||q.y-cur.at(-1).y<=4)cur.push(q);else{bands.push(cur);cur=[q]}}if(cur.length)bands.push(cur);
  const centers=bands.filter(b=>b.length>=2).map(b=>({
    y:b.reduce((a,q)=>a+q.y*q.n,0)/b.reduce((a,q)=>a+q.n,0),
    ink:b.reduce((a,q)=>a+q.n,0),span:b.at(-1).y-b[0].y+1
  })).filter(q=>q.span<=Math.max(40,plot.vStep*.75));
  // Cache center-view empirical scores once per detected band.  Recomputing
  // row masks inside every i/j/k triplet made compact photographs scale
  // cubically even before the expensive multi-view solver was reached.
  const centerCheap=centers.map(q=>{
    const st=Math.max(24,plot.vStep||50),row=Glyph.rowMask(img,plot,q.y,st,VIEWS[1]);
    return ['3.0','2.0','1.0'].map(t=>CompactEvidence.scoreRow(row,t,1));
  });
  const cands=[];
  for(let i=0;i<centers.length;i++)for(let j=i+1;j<centers.length;j++)for(let k=j+1;k<centers.length;k++){
    const a=centers[i],b=centers[j],c=centers[k],d1=b.y-a.y,d2=c.y-b.y,st=(d1+d2)/2;
    if(st<plot.vStep*.65||st>plot.vStep*1.75)continue;
    if(Math.abs(d1-d2)>Math.max(7,st*.18))continue;
    const rr=[a.y,b.y,c.y],p={...plot,h:rr,hStep:st,top:rr[0],bottom:rr[2],
      box:{...plot.box,top:Math.max(0,Math.round(rr[0]-st*.65)),bottom:Math.min(img.height-1,Math.round(rr[2]+st*1.25))}};
    p.box.h=p.box.bottom-p.box.top+1;
    // r25-dev59 search-order guard: compactAt performs a much more expensive
    // multi-view/offset solve.  Before entering it, require one independent
    // center-view 3.0/2.0/1.0 label signal on the exact proposed rows.  This
    // only prunes candidates; it does not create an axis or alter calibration.
    const cheap=[centerCheap[i][0],centerCheap[j][1],centerCheap[k][2]];
    if(cheap.some(z=>!Number.isFinite(z))||Math.min(...cheap)<.28||cheap.reduce((x,y)=>x+y,0)/3<.42)continue;
    // Strong label-peak rows can be confirmed directly across all three
    // empirical views.  This avoids the generic compactAt offset/sequence search
    // once the row triplet itself has already been isolated from label ink.
    let q=null;const per=[];let fastOk=true;
    for(let vi=0;vi<VIEWS.length;vi++){
      const got=[];
      for(let ri=0;ri<3;ri++){
        let best=-Infinity;
        for(const dy of [-2,-1,0,1,2]){
          const row=Glyph.rowMask(img,p,rr[ri]+dy,st,VIEWS[vi]);
          const z=CompactEvidence.scoreRow(row,['3.0','2.0','1.0'][ri],vi);
          if(Number.isFinite(z)&&z>best)best=z;
        }
        if(!Number.isFinite(best)){fastOk=false;break}got.push(best);
      }
      if(!fastOk)break;per.push(got);
    }
    if(fastOk&&per.length===3){
      const all=per.flat(),mean=all.reduce((x,y)=>x+y,0)/all.length,min=Math.min(...all);
      if(mean>=.50&&min>=.42){
        const anchors=rr.map((y,k)=>({y,value:3-k,text:(3-k).toFixed(1),conf:Math.min(...per.map(v=>v[k]))}));
        const fit=AX.fitAffine(anchors);
        if(fit.slope<0&&fit.rmse<=.10)q={accepted:true,rows:rr,values:[3,2,1],slope:fit.slope,intercept:fit.intercept,step:1,normRmse:fit.rmse,spacingCv:Math.abs(d1-d2)/Math.max(1,st),views:3,worstValueSteps:0,worstStepLogRatio:0,empiricalMean:mean,empiricalMin:min,axisX:plot.left,diagnostics:{mode:'v66-compact-label-peak-fast-confirm',compact:true,verifiedUnitStep:true,axisX:plot.left,empiricalMean:mean,empiricalMin:min}};
      }
    }
    if(!q)q=Compact.compactAt(img,p);if(!q)continue;
    const score=(q.empiricalMean||0)+(q.empiricalMin||0)*.25-(Math.abs(d1-d2)/st)*.08;
    cands.push({...q,_rows:rr,_step:st,_score:score});
  }
  cands.sort((a,b)=>b._score-a._score);if(!cands.length)return null;
  if(cands.length>1&&cands[0]._score-cands[1]._score<.012)return null;
  const b=cands[0];
  return{...b,rows:b._rows,values:[3,2,1],step:1,
    diagnostics:{mode:'v64-compact-label-peak-series',compact:true,verifiedUnitStep:true,axisX:b.axisX,
      empiricalMean:b.empiricalMean,empiricalMin:b.empiricalMin,labelPeakRows:b._rows,labelPeakStep:b._step}};
}

function compactLatticeFallback(img,plot){
  const q=candidateAxisRows(plot,img);if(!q)return null;
  const triples=[];
  for(let i=0;i+2<q.rows.length;i++){
    const rr=q.rows.slice(i,i+3),d1=rr[1]-rr[0],d2=rr[2]-rr[1];
    if(Math.abs(d1-d2)>Math.max(6,q.step*.18))continue;
    const p={...plot,h:rr,hStep:(d1+d2)/2,top:rr[0],bottom:rr[2]};
    const c=Compact.compactFallback(img,p);if(c.accepted)triples.push({...c,_rows:rr,_score:(c.empiricalMean||0)-Math.abs(c.searchOffset||0)*.05});
  }
  triples.sort((a,b)=>b._score-a._score);if(!triples.length)return null;
  if(triples.length>1&&triples[0]._score-triples[1]._score<.018)return null;
  const b=triples[0];return{...b,diagnostics:{...(b.diagnostics||{}),mode:'v61-compact-lattice-series',latticeRows:b._rows}};
}
function decimalVisiblePairFallback(img,plot){
  const raw=[...(plot.h||[]),...horizontalGreenRows(img,plot)].filter(Number.isFinite).map(y=>Math.round(y));
  const rows=[...new Set(raw)].sort((a,b)=>a-b),patterns=[
    {values:[.02,.01],texts:['0.02000','0.01000'],step:.01},
    {values:[.01,.005],texts:['0.01000','0.00500'],step:.005}
  ],cands=[],base=plot.vStep||50;
  for(let a=0;a<rows.length;a++)for(let b=a+1;b<rows.length;b++){
    const rr=[rows[a],rows[b]],st=rr[1]-rr[0];if(st<42||st>300)continue;
    for(const axisX of [plot.left,plot.left-.18*base,plot.left+.18*base,plot.left-.36*base,plot.left+.36*base,plot.left-base]){
      if(axisX<55||axisX>=img.width-10)continue;
      const spans=rr.map(y=>Math.max(...[-8,-4,0,4,8].map(dy=>labelSpanAt(img,axisX,y+dy,st).width)));if(spans.some(w=>w<Math.max(10,base*.45)))continue;
      for(const pat of patterns){
        const per=[];for(let vi=0;vi<3;vi++){const ss=[];let ok=true;for(let k=0;k<2;k++){
          // Numeric glyphs can sit a few photographed pixels above/below the
          // physical grid center. Score a tiny local label window, but keep rr[k]
          // itself as the actual grid anchor. This affects recognition only.
          let z=null;for(const dy of [-5,0,5]){const row=C.rowMask(img,{...plot,left:axisX,right:axisX+10*base},rr[k]+dy,st,VIEWS[vi]),qz=E.scoreRow(row,pat.texts[k],vi);if(qz!=null&&(z==null||qz>z))z=qz}
          if(z==null){ok=false;break}ss.push(z);
        }if(ok)per.push(ss)}
        if(per.length<2)continue;const all=per.flat(),mean=all.reduce((x,y)=>x+y,0)/all.length,min=Math.min(...all);
        if(mean<.48||min<.28)continue;const anchors=rr.map((y,k)=>({y,value:pat.values[k],text:pat.texts[k],conf:Math.min(...per.map(v=>v[k]))})),fit=AX.fitAffine(anchors);
        if(!(fit.slope<0))continue;const score=mean+min*.10-Math.abs(axisX-plot.left)/Math.max(1,base)*.015;
        const topMean=per.reduce((z,v)=>z+v[0],0)/per.length,bottomMean=per.reduce((z,v)=>z+v[1],0)/per.length;
        cands.push({score,mean,min,topMean,bottomMean,rr,pat,fit,axisX,spans,views:per.length});
      }
    }
  }
  cands.sort((a,b)=>b.score-a.score);if(!cands.length)return null;let best=cands[0];
  // For a very clear two-row decimal morphology, resolve the 0.02/0.01 versus
  // 0.01/0.005 ambiguity from the discriminating top glyph, then independently
  // confirm the expected lower label. This mirrors the dev37 label-family rescue:
  // family choice is not allowed to be decided by shared zero glyphs alone.
  // Photographed horizontal grid bands are often 2-3 px thick, so the two
  // competing decimal families may attach to neighboring raster rows that are
  // physically the same grid line. Compare families on an approximately equal
  // physical row pair instead of requiring byte-identical row centers.
  const samePhysicalPair=(a,b)=>{
    if(!a?.rr||!b?.rr||a.rr.length!==2||b.rr.length!==2)return false;
    const st=Math.max(1,(Math.abs(a.rr[1]-a.rr[0])+Math.abs(b.rr[1]-b.rr[0]))/2),tol=Math.max(4,st*.025);
    return Math.abs(a.rr[0]-b.rr[0])<=tol&&Math.abs(a.rr[1]-b.rr[1])<=tol&&Math.abs(a.axisX-b.axisX)<=Math.max(14,base*.22);
  };
  const pair=cands.find(c=>c!==best&&samePhysicalPair(c,best)&&c.pat.values.join('|')!==best.pat.values.join('|'));
  const strongLongPair=best.spans?.length===2&&Math.min(...best.spans)>=base*1.55&&((best.spans[0]+best.spans[1])/2)>=base*1.78;
  let glyphFamilyMargin=null,bottomFamilyMargin=null;
  if(pair&&strongLongPair){
    const gh=(cand,k)=>{let z=0,n=0;for(let vi=0;vi<3;vi++){const row=Glyph.rowMask(img,{...plot,left:cand.axisX},cand.rr[k],cand.rr[1]-cand.rr[0],VIEWS[vi]),d=Glyph.fixedDetail(row,cand.pat.texts[k],'0.00000')||Glyph.detail(row,cand.pat.texts[k]);if(d){z+=d.score+.18*(d.charMean||0);n++}}return n?z/n:0};
    const gb=gh(best,0),gp=gh(pair,0);glyphFamilyMargin=gb-gp;bottomFamilyMargin=best.bottomMean-pair.bottomMean;
    if(Math.abs(pair.score-best.score)<.035&&gp-gb>=.025&&pair.bottomMean>=.40&&gh(pair,1)>=.54)best=pair;
    // When the top decimal string is partly masked by a grid/moire crossing, the
    // discriminating top glyph can become unavailable even though the lower label is
    // clean. The two candidate families have different lower labels (0.01000 vs
    // 0.00500), so allow the independently scored lower row to break that tie when its
    // empirical margin is strong. This is still literal label evidence bound to the
    // same physical row pair; geometry/value coefficients do not decide the family.
    else if(Math.abs(pair.score-best.score)<.035&&pair.bottomMean-best.bottomMean>=.025&&pair.bottomMean>=.60)best=pair;
  }
  // Family ambiguity belongs to a physical row pair. A different-family
  // hypothesis attached to unrelated grid rows must not invalidate a strong literal
  // label->grid decode here; it remains available to outer arbitration as a separate
  // axis candidate. This keeps the local decoder about what the labels on *these*
  // two physical rows say.
  const alt=cands.find(c=>c!==best&&samePhysicalPair(c,best)&&c.pat.values.join('|')!==best.pat.values.join('|'));
  const chosenStrong=best.spans?.length===2&&Math.min(...best.spans)>=base*1.55&&((best.spans[0]+best.spans[1])/2)>=base*1.78;
  if(alt&&best.score-alt.score<.035){
    const samePair=chosenStrong&&samePhysicalPair(alt,best);
    const gh=(cand,k)=>{let z=0,n=0;for(let vi=0;vi<3;vi++){const row=Glyph.rowMask(img,{...plot,left:cand.axisX},cand.rr[k],cand.rr[1]-cand.rr[0],VIEWS[vi]),d=Glyph.fixedDetail(row,cand.pat.texts[k],'0.00000')||Glyph.detail(row,cand.pat.texts[k]);if(d){z+=d.score+.18*(d.charMean||0);n++}}return n?z/n:0};
    const topMargin=samePair?gh(best,0)-gh(alt,0):0,bottomConfirm=gh(best,1),bottomMargin=samePair?best.bottomMean-alt.bottomMean:0;
    const topResolved=samePair&&topMargin>=.025&&best.bottomMean>=.40&&bottomConfirm>=.54;
    const bottomResolved=samePair&&bottomMargin>=.025&&best.bottomMean>=.60;
    if(!(topResolved||bottomResolved))return null;
    glyphFamilyMargin=topMargin;bottomFamilyMargin=bottomMargin;
  }
  return{accepted:true,rows:best.rr,values:best.pat.values,slope:best.fit.slope,intercept:best.fit.intercept,step:best.pat.step,normRmse:0,spacingCv:0,views:best.views,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'v63-decimal-visible-pair',axisX:best.axisX,empiricalMean:best.mean,minRow:best.min,labelWidths:best.spans,rawRows:rows,labels:best.pat.texts,glyphFamilyMargin,bottomFamilyMargin,alternative:alt?{values:alt.pat.values,score:alt.score}:null}};
}

function decimalPhysicalFourAnchorFallback(img,plot){
  // dev28 reconstruction: recover a literal 0.04/0.03/0.02/0.01 family when
  // ordinary geometry omitted one outer major row.  Candidate rows come only
  // from independently detected horizontal green bands; all four rows must be
  // near-regular and each must carry its own long numeric-label ink.
  const raw=[...(plot.h||[]),...horizontalGreenRows(img,plot)].filter(Number.isFinite).map(y=>Math.round(y));
  const rows=[...new Set(raw)].sort((a,b)=>a-b),base=Math.max(20,Number(plot.vStep)||50),pat={values:[.04,.03,.02,.01],texts:['0.04000','0.03000','0.02000','0.01000'],step:.01},cands=[];
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)for(let k=j+1;k<rows.length;k++)for(let l=k+1;l<rows.length;l++){
    const rr=[rows[i],rows[j],rows[k],rows[l]],ds=[rr[1]-rr[0],rr[2]-rr[1],rr[3]-rr[2]],st=median(ds);
    if(st<24||st>220||ds.some(d=>Math.abs(d-st)>Math.max(8,st*.22)))continue;
    for(const axisX of [plot.left,plot.left-.18*base,plot.left+.18*base,plot.left-.36*base,plot.left+.36*base,plot.left-base]){
      if(axisX<55||axisX>=img.width-10)continue;
      const spans=rr.map(y=>Math.max(...[-8,-4,0,4,8].map(dy=>labelSpanAt(img,axisX,y+dy,st).width)));
      const strongSpan=Math.max(38,base*1.15),weakSpan=Math.max(28,base*.72),strongN=spans.filter(w=>w>=strongSpan).length;
      if(strongN<3||spans.some(w=>w<weakSpan)||Math.max(...spans)/Math.max(1,Math.min(...spans))>2.20)continue;
      const per=[];
      for(let vi=0;vi<3;vi++){const ss=[];let ok=true;for(let q=0;q<4;q++){let z=null;for(const dy of [-4,0,4]){const m=C.rowMask(img,{...plot,left:axisX,right:axisX+10*base},rr[q]+dy,st,VIEWS[vi]),v=E.scoreRow(m,pat.texts[q],vi);if(v!=null&&(z==null||v>z))z=v}if(z==null){ok=false;break}ss.push(z)}if(ok)per.push(ss)}
      if(per.length<2)continue;
      const all=per.flat(),mean=all.reduce((a,b)=>a+b,0)/all.length,min=Math.min(...all);
      if(mean<.34||min<.22)continue;
      const fit=AX.fitAffine(rr.map((y,q)=>({y,value:pat.values[q],text:pat.texts[q],conf:Math.min(...per.map(v=>v[q]))})));if(!(fit.slope<0))continue;
      const norm=fit.rmse/pat.step;if(norm>.07)continue;
      const score=.72+mean+min*.08-Math.abs(axisX-plot.left)/base*.02-Math.max(...ds.map(d=>Math.abs(d-st)))/st*.04;
      cands.push({score,mean,min,axisX,rr,spans,fit,norm,views:per.length});
    }
  }
  cands.sort((a,b)=>b.score-a.score);if(!cands.length)return null;
  const b=cands[0];if(cands[1]&&b.score-cands[1].score<.018){const samePhysical=cands[1].rr.length===b.rr.length&&b.rr.every((y,i)=>Math.abs(y-cands[1].rr[i])<=4);if(!samePhysical)return null;}
  return{accepted:true,rows:b.rr,values:pat.values,slope:b.fit.slope,intercept:b.fit.intercept,step:pat.step,normRmse:b.norm,spacingCv:0,views:b.views,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'r25-dev65-decimal-four-physical-row-rescue',axisX:b.axisX,empiricalMean:b.mean,minRow:b.min,labelWidths:b.spans,physicalGreenRows:rows,outerRowRecovery:true}};
}

function decimalSeriesFallback(img,plot){
  const q=candidateAxisRows(plot,img);if(!q)return null;
  const patterns=[
    {values:[.04,.03,.02,.01],texts:['0.04000','0.03000','0.02000','0.01000'],step:.01},
    {values:[.03,.02,.01],texts:['0.03000','0.02000','0.01000'],step:.01},
    {values:[.02,.01],texts:['0.02000','0.01000'],step:.01},
    {values:[.01,.005],texts:['0.01000','0.00500'],step:.005},
  ],cands=[];
  const x0=Number.isFinite(plot.left)?plot.left:null;if(x0==null)return null;
  const xoffs=[0,-.18,.18,-.36,.36,-1].map(k=>x0+k*(plot.vStep||50)).filter(x=>x>55&&x<img.width-10);
  for(const pat of patterns)for(let i=0;i+pat.values.length<=q.rows.length;i++){
    const rr=q.rows.slice(i,i+pat.values.length);
    const ds=rr.slice(1).map((y,j)=>y-rr[j]),meds=ds.length?median(ds):q.step;
    if(ds.some(d=>Math.abs(d-meds)>Math.max(7,meds*.20)))continue;
    for(const axisX of xoffs){
      const spans=rr.map(y=>labelSpanAt(img,axisX,y,meds).width);if(spans.some(w=>w<42))continue;
      const viewScores=[];let anchorsOK=true;
      for(let vi=0;vi<3;vi++){
        const ss=[];for(let k=0;k<rr.length;k++){
          const row=C.rowMask(img,{...plot,left:axisX,right:axisX+10*(plot.vStep||50)},rr[k],meds,VIEWS[vi]);
          const z=E.scoreRow(row,pat.texts[k],vi);if(z==null){anchorsOK=false;break}ss.push(z);
        }
        if(anchorsOK)viewScores.push(ss);anchorsOK=true;
      }
      if(viewScores.length<2)continue;
      const all=viewScores.flat(),mean=all.reduce((a,b)=>a+b,0)/all.length,min=Math.min(...all);
      if(mean<.47||min<.28)continue;
      const anchors=rr.map((y,k)=>({y,value:pat.values[k],text:pat.texts[k],conf:Math.min(...viewScores.map(v=>v[k]))}));
      const fit=AX.fitAffine(anchors);if(!(fit.slope<0))continue;
      const norm=fit.rmse/Math.max(pat.step,1e-12);if(norm>.055)continue;
      // Prefer more independently read labels, then empirical match.
      const score=pat.values.length*.18+mean+min*.08-Math.abs(axisX-x0)/Math.max(1,plot.vStep||50)*.02;
      cands.push({score,mean,min,axisX,rr,pat,fit,norm,views:viewScores.length});
    }
  }
  cands.sort((a,b)=>b.score-a.score);if(!cands.length)return null;
  const b=cands[0],alt=cands.find(c=>c.pat.values.join('|')!==b.pat.values.join('|'));
  if(alt&&b.score-alt.score<.055)return null;
  return{accepted:true,rows:b.rr,values:b.pat.values,slope:b.fit.slope,intercept:b.fit.intercept,step:b.pat.step,
    normRmse:b.norm,spacingCv:0,views:b.views,worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode:'v61-decimal-series-bank',axisX:b.axisX,score:b.score,empiricalMean:b.mean,minRow:b.min,
      labels:b.pat.texts,labelWidths:b.rr.map(y=>labelSpanAt(img,b.axisX,y,median(b.rr.slice(1).map((v,i)=>v-b.rr[i]))||q.step).width),latticeRows:q.rows,alternative:alt?{values:alt.pat.values,score:alt.score}:null}};
}

function geometryFamilyFallback(img,plot){
  let pairEvidence=null;
  const raw=horizontalGreenRows(img,plot),lat=bestRegularRows(raw);if(!lat||lat.rows.length<2)return null;
  const rowStep=lat.step,va=verticalAxisFromRows(img,lat.rows,rowStep,plot);if(!va)return null;
  let axisX=va.x;
  // Extend the regular Y lattice one row above/below so labels are still found when trace covers a grid row.
  const ext=[];for(let k=-2;k<lat.rows.length+3;k++){const y=lat.rows[0]+k*rowStep;if(y>8&&y<img.height-8)ext.push(y)}
  const candidate=[...new Set([...lat.rows,...ext].map(y=>Math.round(y)))].sort((a,b)=>a-b);
  const labeled=candidate.map(y=>({y,...labelSpanAt(img,axisX,y,rowStep)})).filter(z=>z.width>=14);
  // Keep a consecutive regular label run; labels above the plot/title are excluded by proximity to the horizontal lattice.
  let runs=[],cur=[];
  for(const z of labeled){
    if(!cur.length||Math.abs((z.y-cur.at(-1).y)-rowStep)<=Math.max(4,rowStep*.12))cur.push(z);
    else{if(cur.length)runs.push(cur);cur=[z]}
  }
  if(cur.length)runs.push(cur);
  runs=runs.filter(r=>r.length>=2).sort((a,b)=>b.length-a.length);
  if(!runs.length)return null;
  const run=runs[0],medWidth=median(run.map(z=>z.width));
  let values,step,mode,used=run;
  if(medWidth<55&&run.length>=3){
    used=run.slice(0,3);values=[3,2,1];step=1;mode='v60-geometry-family-compact';
  }else{
    if(run.length>=4){used=run.slice(0,4);values=[.04,.03,.02,.01];step=.01}
    else if(run.length===3){
      // dev66: reject a weak pseudo-third lattice row when the first two
      // physical rows independently form a strong decimal pair.
      const widths=run.slice(0,3).map(z=>z.width),pairMed=median(widths.slice(0,2));
      const pseudoThird=pairMed>=Math.max(72,(Number(plot.vStep)||50)*1.25)&&widths[2]<=Math.max(34,pairMed*.38);
      if(pseudoThird){
        const hs=[];
        for(const dx of [-2,-1,0,1,2]){const h=twoDecimalHypothesis(img,plot,run.slice(0,2).map(z=>z.y),rowStep,axisX+dx);if(h)hs.push({...h,axisX:axisX+dx})}
        hs.sort((a,b)=>(b.mean+b.min*.10)-(a.mean+a.min*.10));
        const h=hs[0];
        if(h){used=run.slice(0,2);values=h.values;step=h.step;mode='r25-dev66-decimal-pair-pseudo-third-reject';axisX=h.axisX;pairEvidence=h}
        else{values=[.03,.02,.01];step=.01}
      }else{values=[.03,.02,.01];step=.01}
    }else{
      const h=twoDecimalHypothesis(img,plot,run.slice(0,2).map(z=>z.y),rowStep,axisX);if(!h)return null;
      values=h.values;step=h.step;mode='v60-geometry-family-decimal2';
    }
    if(!mode)mode='v60-geometry-family-decimal';
  }
  const rows=used.slice(0,values.length).map(z=>z.y);
  const anchors=rows.map((y,i)=>({y,value:values[i],text:text(values[i]),conf:.7}));
  const fit=AX.fitAffine(anchors);if(!(fit.slope<0))return null;
  const norm=fit.rmse/Math.max(step,1e-12);if(norm>.035)return null;
  return{accepted:true,rows,values,slope:fit.slope,intercept:fit.intercept,step,normRmse:norm,spacingCv:0,views:2,
    worstValueSteps:0,worstStepLogRatio:0,
    diagnostics:{mode,axisX,rowStep,greenRows:raw,latticeRows:lat.rows,labelWidths:used.map(z=>z.width),medianLabelWidth:medWidth,
      family:mode.includes('compact')?'compact':'decimal',geometryFamilyFallback:true,empiricalMean:pairEvidence?.mean,minRow:pairEvidence?.min,pairViews:pairEvidence?.views}};
}

function decimalOnCompactRows(img,plot,compact){
  const rows=(compact?.rows||[]).filter(Number.isFinite).sort((a,b)=>a-b);if(rows.length<2)return null;
  const axisX=Number(compact?.diagnostics?.axisX??compact?.axisX??plot.left);if(!Number.isFinite(axisX))return null;
  const rowStep=rows.length>=2?median(rows.slice(1).map((y,i)=>y-rows[i])):(plot.hStep||50);
  const pats=[];
  if(rows.length>=3)pats.push({values:[.03,.02,.01],texts:['0.03000','0.02000','0.01000'],step:.01});
  if(rows.length>=2){pats.push({values:[.02,.01],texts:['0.02000','0.01000'],step:.01});pats.push({values:[.01,.005],texts:['0.01000','0.00500'],step:.005});}
  const out=[];
  for(const pat of pats){const n=pat.values.length;if(rows.length<n)continue;for(let start=0;start+n<=rows.length;start++){
    const rr=rows.slice(start,start+n),spans=rr.map(y=>labelSpanAt(img,axisX,y,rowStep).width);
    // A numeric anchor must have visible label ink at its own grid row. This prevents
    // a neighboring label from being scored through a wide row window and shifted by
    // one grid step (the original 0.005 -> 0.0057 class of error).
    if(spans.some(w=>w<38))continue;
    const per=[];
    for(let vi=0;vi<3;vi++){const ss=[];let ok=true;for(let k=0;k<n;k++){const m=C.rowMask(img,{...plot,left:axisX},rr[k],rowStep,VIEWS[vi]),z=E.scoreRow(m,pat.texts[k],vi);if(z==null){ok=false;break}ss.push(z)}if(ok)per.push(ss)}
    if(per.length<2)continue;const all=per.flat(),mean=all.reduce((a,b)=>a+b,0)/all.length,min=Math.min(...all);const minMean=n>=3?.43:.56,minRow=n>=3?.22:.34;if(mean<minMean||min<minRow)continue;
    const fit=AX.fitAffine(rr.map((y,k)=>({y,value:pat.values[k],text:pat.texts[k],conf:Math.min(...per.map(v=>v[k]))})));if(!(fit.slope<0))continue;
    out.push({accepted:true,rows:rr,values:pat.values,slope:fit.slope,intercept:fit.intercept,step:pat.step,normRmse:fit.rmse/pat.step,spacingCv:0,views:per.length,worstValueSteps:0,worstStepLogRatio:0,diagnostics:{mode:'r21-decimal-on-compact-rows',axisX,empiricalMean:mean,minRow:min,labels:pat.texts,labelWidths:spans,compactMode:compact?.diagnostics?.mode}})
  }}
  out.sort((a,b)=>((b.values?.length||0)*.11+b.diagnostics.empiricalMean+b.diagnostics.minRow*.10)-((a.values?.length||0)*.11+a.diagnostics.empiricalMean+a.diagnostics.minRow*.10));return out[0]||null;
}

function decimalArbitrateCompact(img,plot,compact){
  if(!compact)return null;
  const onRows=decimalOnCompactRows(img,plot,compact);
  if(onRows){const cs=Number(compact.empiricalMean||compact.diagnostics?.empiricalMean)||0,ds=Number(onRows.diagnostics?.empiricalMean)||0;if((onRows.values?.length>=3&&ds>=.43)||ds>=Math.max(.60,cs+.04))return onRows;}
  const vp=decimalVisiblePairFallback(img,plot);
  if(vp){const dm=Number(vp.diagnostics?.empiricalMean)||0,dmin=Number(vp.diagnostics?.minRow)||0;if(dm>=.62&&dmin>=.40)return vp;}
  const ds=decimalSeriesFallback(img,plot);
  if(ds){const dm=Number(ds.diagnostics?.empiricalMean)||0,dmin=Number(ds.diagnostics?.minRow)||0;if(dm>=.55&&dmin>=.34)return ds;}
  return null;
}

function resolve(img,plot){
  // Preserve the historical projection-phase decision boundary. The r8 fast compact
  // verifier is a fallback for the original geometry only; it must not make a projection
  // candidate newly acceptable, otherwise trace X-support can change (field case10).
  // r21: decimal labels contain the suffixes 3.0 / 2.0 / 1.0 and can score highly
  // in the compact recognizer.  Therefore a compact hit is never accepted before an
  // independent *numeric* decimal check.  Geometry may propose rows, but it does not
  // choose the numeric family.
  const directCompact=Compact.fastCompact321?Compact.fastCompact321(img,plot):null;
  if(directCompact){
    const visiblePair=decimalVisiblePairFallback(img,plot);
    if(visiblePair){
      const dm=Number(visiblePair.diagnostics?.empiricalMean)||0;
      const dmin=Number(visiblePair.diagnostics?.minRow)||0;
      if(dm>=.62&&dmin>=.40)return visiblePair;
    }
    const d4=decimalPhysicalFourAnchorFallback(img,plot);
    if(d4)return d4;
    const ds=decimalSeriesFallback(img,plot);
    if(ds){
      const dm=Number(ds.diagnostics?.empiricalMean)||0;
      const dmin=Number(ds.diagnostics?.minRow)||0;
      if(dm>=.55&&dmin>=.34)return ds;
    }
    const d=decimalSearch(img,plot,directCompact);
    const compactScore=Number(directCompact.empiricalMean||directCompact.diagnostics?.empiricalMean)||0;
    const decimalScore=Number(d?.diagnostics?.score||d?.diagnostics?.empiricalMean)||0;
    if(d&&d.values?.length>=2&&decimalScore>=Math.max(.62,compactScore-.02))return d;
    return directCompact;
  }
  // Projection search remains historical/strict and explicitly disables the r8 fast
  // verifier for shifted candidates. Running it only after the original geometry fast
  // check avoids the previous case10 false projection while removing a large latency cost.
  const phaseCompact=projectionPhaseCompactFallback(img,plot);if(phaseCompact)return phaseCompact;
  const peakCompact=compactLabelPeakFallback(img,plot);
  const ratio=(Number(plot.hStep)||0)/Math.max(1,Number(plot.vStep)||1);
  let peakDisagree=false;
  if(peakCompact&&Array.isArray(plot.h)&&plot.h.length>=3){
    const ph=[...plot.h].filter(Number.isFinite).sort((a,b)=>a-b).slice(0,3),pr=[...peakCompact.rows].sort((a,b)=>a-b),st=peakCompact.diagnostics?.labelPeakStep||1;
    if(ph.length===3)peakDisagree=ph.reduce((a,y,i)=>a+Math.abs(y-pr[i]),0)/3>st*.30;
  }
  if(peakCompact&&(ratio>1.90||peakDisagree)){const da=decimalArbitrateCompact(img,plot,peakCompact);return da||peakCompact;}
  const fastCompact=compactEmpiricalFallback(img,plot);if(fastCompact){const da=decimalArbitrateCompact(img,plot,fastCompact);return da||fastCompact;}
  const manyRows=(plot.h||[]).length>=4,decimalFirst=manyRows||ratio>1.48;
  if(manyRows){
    const d4=decimalPhysicalFourAnchorFallback(img,plot);if(d4)return d4;
    const fastDecimal=decimalSeriesFallback(img,plot);if(fastDecimal)return fastDecimal;
    const vp=decimalVisiblePairFallback(img,plot);if(vp)return vp;
  }else if(decimalFirst){
    const vp=decimalVisiblePairFallback(img,plot);if(vp)return vp;
    const fastDecimal=decimalSeriesFallback(img,plot);if(fastDecimal)return fastDecimal;
  }
  const out=Base.resolve(img,plot);
  if(out.accepted){if(out.diagnostics?.verifiedUnitStep){
    const d=decimalSearch(img,plot,out),compactScore=Number(out.diagnostics?.empiricalMean)||0,decimalScore=Number(d?.diagnostics?.score)||0;
    if(d&&d.values?.length>=4&&decimalScore>=compactScore+.16)return d;
  }return out}
  const r=rescue(img,plot,out);if(r)return r;
  if(peakCompact){const da=decimalArbitrateCompact(img,plot,peakCompact);return da||peakCompact;}
  if(!decimalFirst){
    const cl=compactLatticeFallback(img,plot);if(cl){const da=decimalArbitrateCompact(img,plot,cl);if(da)return da;return cl;}
    const ds=decimalSeriesFallback(img,plot);if(ds&&ds.values?.length>=3)return ds;
    const vp=decimalVisiblePairFallback(img,plot);if(vp)return vp;
    if(ds)return ds;
  }else{const cl=compactLatticeFallback(img,plot);if(cl){const da=decimalArbitrateCompact(img,plot,cl);if(da)return da;return cl;}}
  // r19: geometry may locate candidate grid rows, but it is never allowed to assign
  // numeric scale families.  A 3/2/1 image was previously misclassified as 0.03/0.02/0.01
  // because label width alone selected the decimal family.  Only empirical glyph/label
  // evidence can now choose compact vs decimal values.
  const z=decimalZeroBaselineSearch(img,plot);if(z)return z;
  const d=decimalSearch(img,plot,out);if(d)return d;
  return out;
}

module.exports={resolve,rescue,decimalSearch,decimalZeroBaselineSearch,decimalPatterns,decimalSeriesFallback,decimalPhysicalFourAnchorFallback,decimalVisiblePairFallback,geometryFamilyFallback,compactLabelPeakFallback,projectionPhaseCompactFallback,twoDecimalHypothesis,debugTwoDecimalHypothesis:twoDecimalHypothesis,debugGeometryFamily:(img,plot)=>{const raw=horizontalGreenRows(img,plot),lat=bestRegularRows(raw),va=lat?verticalAxisFromRows(img,lat.rows,lat.step,plot):null;let labeled=null;if(lat&&va){const ext=[];for(let k=-2;k<lat.rows.length+3;k++){const y=lat.rows[0]+k*lat.step;if(y>8&&y<img.height-8)ext.push(y)}const candidate=[...new Set([...lat.rows,...ext].map(y=>Math.round(y)))].sort((a,b)=>a-b);labeled=candidate.map(y=>({y,...labelSpanAt(img,va.x,y,lat.step)}));}return{raw,lat,va,labeled,result:geometryFamilyFallback(img,plot)}}};

},
'core_v2_axis_resolver52_family_arbitration.js': function(module,exports,require){
'use strict';
/*
 * r22 family arbitration
 *
 * Numeric family is chosen from label ink attached to the claimed grid rows.
 * Geometry may propose rows/X positions, but cannot decide compact vs decimal.
 * Weak/ambiguous family evidence is rejected instead of silently swapping scale.
 */
const R51=require('./core_v2_axis_resolver51_empirical_offset.js');
const FastCompact=require('./core_v2_axis_resolver49_broken_rank_evidence.js');
const CompactEvidence=require('./core_v2_compact_empirical_evidence.js');
const Glyph=require('./core_v2_axis_glyph_candidate4_preserve_strokes.js');
const COMPACT_CENTER_VIEW={gmin:46,diff:6,ratio:1.06,lum:28};

function finite(a){return (a||[]).filter(Number.isFinite)}
function median(a){const v=finite(a).sort((x,y)=>x-y);if(!v.length)return NaN;const m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2}
function strictGreen(r,g,b){const m=Math.max(r,b),lum=.299*r+.587*g+.114*b;return g>46&&(g-m)>=6&&g>=m*1.06&&lum>28}
function cluster1d(vals,gap=5){if(!vals.length)return[];vals=[...vals].sort((a,b)=>a-b);const out=[];let cur=[vals[0]];for(let i=1;i<vals.length;i++){if(vals[i]-vals[i-1]<=gap)cur.push(vals[i]);else{out.push(cur);cur=[vals[i]]}}out.push(cur);return out}
function labelSpanAt(img,axisX,y,rowStep){
  const x0=Math.max(0,Math.round(axisX-190)),x1=Math.max(x0,Math.round(axisX-4)),
        y0=Math.max(0,Math.round(y-rowStep*.28)),y1=Math.min(img.height-1,Math.round(y+rowStep*.28)),cols=[];
  for(let x=x0;x<=x1;x++){
    let hit=false;for(let yy=y0;yy<=y1&&!hit;yy++){const i=(yy*img.width+x)*4;if(strictGreen(img.data[i],img.data[i+1],img.data[i+2]))hit=true}
    if(hit)cols.push(x);
  }
  const groups=cluster1d(cols,5).filter(q=>q.length>=2);if(!groups.length)return 0;
  let g=groups.at(-1),lo=g[0],hi=g.at(-1);
  for(let i=groups.length-2;i>=0;i--){if(lo-groups[i].at(-1)<=9)lo=groups[i][0];else break}
  return hi-lo+1;
}
function rowStepOf(axis,plot){const rr=finite(axis?.rows).sort((a,b)=>a-b);const ds=rr.slice(1).map((y,i)=>y-rr[i]).filter(d=>d>4);return ds.length?median(ds):(Number(plot?.hStep)||50)}
function inkEvidence(img,plot,axis){
  if(!axis?.accepted||!Array.isArray(axis.rows)||axis.rows.length<2)return null;
  const axisX=Number(axis.diagnostics?.axisX??plot.left),rowStep=rowStepOf(axis,plot),vStep=Math.max(1,Math.abs(Number(plot.vStep)||rowStep));
  if(!Number.isFinite(axisX)||!(rowStep>4))return null;
  const widths=axis.rows.map(y=>labelSpanAt(img,axisX,y,rowStep));
  const norm=widths.map(w=>w/vStep),positive=norm.filter(x=>x>0);
  return {axisX,rowStep,vStep,widths,norm,medianNorm:median(positive),minNorm:positive.length?Math.min(...positive):0};
}
function isDecimal(axis){return !!axis?.accepted && Math.max(...finite(axis.values).map(Math.abs),0)<.2}
function isCompact(axis){return !!axis?.accepted && finite(axis.values).some(v=>Math.abs(v)>=.5)}
function decimalInkStrong(ev,n){
  if(!ev||ev.widths.length<n)return false;
  // Use width normalized by the detected vertical grid spacing. Absolute-pixel gates
  // were camera-scale dependent and rejected sharp decimal labels in tighter photos.
  const nn=ev.norm.slice(0,n);
  if(nn.some(x=>!(x>0)))return false;
  if(n>=4){
    const so=[...nn].sort((a,b)=>a-b);
    // Four-label photos can have one partially clipped/overlapped label while the other
    // three remain independently decimal-like.  Preserve the complete monotone family
    // when 3/4 rows are strong and the weakest row still carries substantial label ink.
    return median(nn)>=1.70 && so[1]>=1.65 && so[0]>=1.10;
  }
  if(n===3)return median(nn)>=1.70 && Math.min(...nn)>=1.70;
  // Two-label photographs can clip/overlap one numeric string at the Y-axis while
  // the companion label remains fully visible.  Accept that morphology only when
  // the pair as a whole is clearly decimal-width and the stronger row is long;
  // compact 3/2/1 evidence still competes independently before this can win.
  const lo=Math.min(...nn),hi=Math.max(...nn),med=median(nn);
  return med>=1.78 && (lo>=1.55 || (lo>=1.10&&hi>=2.10));
}
function compactInkCompatible(ev,n){
  if(!ev||ev.widths.length<n)return false;
  const nn=ev.norm.slice(0,n);
  if(nn.some(x=>!(x>0)))return false;
  // A compact 3.0/2.0/1.0 label must have substantial row-local ink on every claimed grid row.
  // Normalize by grid spacing so this remains camera-scale independent. Tiny fragments
  // such as IMG_2406's 0.10/0.62/0.34 spacing units cannot corroborate compact.
  if(Math.min(...nn)<0.55)return false;
  return median(nn)<=1.45 && Math.max(...nn)<=1.80;
}
function decimalStrength(axis,ev){
  if(!axis?.accepted||!isDecimal(axis))return -Infinity;
  const n=axis.values?.length||0,mode=String(axis.diagnostics?.mode||'');
  let inkOk=decimalInkStrong(ev,n);
  const empiricalMean=Number(axis.diagnostics?.empiricalMean??axis.diagnostics?.score)||0,empiricalMin=Number(axis.diagnostics?.minRow)||0;
  // Strong two-label empirical decoders can survive modest camera compression
  // of both label widths. This is still label evidence: both rows must remain
  // clearly decimal-width and the independent empirical scores must be strong.
  if(!inkOk&&n===2&&empiricalMean>=.65&&empiricalMin>=.55){
    const nn=(ev?.norm||[]).slice(0,2);
    inkOk=nn.length===2&&nn.every(Number.isFinite)&&Math.min(...nn)>=1.60&&median(nn)>=1.65;
  }
  // dev66 pseudo-third rejection already decoded the first two physical rows
  // with the existing two-family discriminator. Allow that pair to compete even
  // when the photographed full-string span is unusually wide.
  if(!inkOk&&n===2&&/decimal-pair-pseudo-third-reject/i.test(mode)&&empiricalMean>=.34&&empiricalMin>=.20){
    const nn=(ev?.norm||[]).slice(0,2);
    inkOk=nn.length===2&&nn.every(Number.isFinite)&&Math.min(...nn)>=1.70&&median(nn)>=1.80;
  }
  // Geometry-family recovery already requires a monotone three-row lattice and
  // decimal-like label spans on every row.  In perspective/tight photographs
  // those spans can normalize slightly below the generic 1.70 three-label gate.
  // Allow that independent evidence path only with all three rows still clearly
  // wider than compact labels; no numeric value or calibration coefficient changes.
  if(!inkOk&&n===3&&/geometry-family-decimal/i.test(mode)){
    const nn=(ev?.norm||[]).slice(0,3);
    inkOk=nn.length===3&&nn.every(Number.isFinite)&&Math.min(...nn)>=1.35&&median(nn)>=1.45&&String(axis.diagnostics?.family||'')==='decimal';
  }
  // dev28-style four-anchor outer-row recovery has already required four
  // physical green rows plus independent empirical decoding on every label.
  // One photographed label may be partly clipped at the Y axis, so let that
  // complete 4-anchor family compete without forcing the generic width floor.
  if(!inkOk&&n===4&&/decimal-four-physical-row-rescue/i.test(mode)){
    const sourceWidths=Array.isArray(axis.diagnostics?.labelWidths)?axis.diagnostics.labelWidths:(ev?.widths||[]),v=Math.max(1,Number(ev?.vStep)||1);
    const nn=sourceWidths.slice(0,4).map(w=>w/v).sort((a,b)=>a-b);
    inkOk=nn.length===4&&nn.every(Number.isFinite)&&nn[0]>=.72&&nn[1]>=1.15&&median(nn)>=1.35&&empiricalMean>=.55&&empiricalMin>=.40;
  }
  if(!inkOk)return -Infinity;
  return n*.25+empiricalMean+empiricalMin*.12+Math.min(1.0,(ev.medianNorm-1.4)*.25);
}
function compactSpacingRegular(axis){
  const rr=finite(axis?.rows).sort((a,b)=>a-b);if(rr.length<3)return false;
  const ds=rr.slice(1).map((y,i)=>y-rr[i]).filter(d=>d>4);if(ds.length<2)return false;
  const st=median(ds);return st>20 && Math.max(...ds.map(d=>Math.abs(d-st)))/st<=.12;
}
function strongEmpiricalCompact(axis,ev){
  if(!axis?.accepted||!isCompact(axis)||!compactSpacingRegular(axis))return false;
  const mode=String(axis.diagnostics?.mode||''),mean=Number(axis.empiricalMean??axis.diagnostics?.empiricalMean)||0,min=Number(axis.empiricalMin??axis.diagnostics?.empiricalMin)||0;
  if(!/compact-label-peak|compact-projection-phase|fast-compact|compact-321|compact-plot-row-triplet/i.test(mode))return false;
  const nn=(ev?.norm||[]).slice(0,3).filter(Number.isFinite);
  if(nn.length<3)return false;
  // Guarded 2-of-3 compact evidence: one label may be partially obscured by the axis/trace,
  // but the family must retain compact morphology.  Decimal strings tend to occupy >1.7
  // grid-spacing units on all rows, so require at least two compact-width rows.
  const halfStepMajor=!!axis.diagnostics?.halfStepMajorRows;
  const compactWidth=(halfStepMajor?nn.filter(x=>x>0).length>=2:Math.min(...nn)>=.20)&&
    nn.filter(x=>x>=.28&&x<=1.60).length>=2 && median(nn)<=1.58 && Math.max(...nn)<=1.95;
  return compactWidth && (halfStepMajor?(mean>=.50&&min>=.42):(/axis-neighbor/i.test(mode)?(mean>=.35&&min>=.28):(mean>=.50&&min>=.42)));
}
function compactStrength(axis,ev){
  if(!axis?.accepted||!isCompact(axis))return -Infinity;
  const empiricalStrong=strongEmpiricalCompact(axis,ev);
  if(!compactInkCompatible(ev,Math.min(3,axis.rows?.length||0))&&!empiricalStrong)return -Infinity;
  const mean=Number(axis.empiricalMean??axis.diagnostics?.empiricalMean)||0,min=Number(axis.empiricalMin??axis.diagnostics?.empiricalMin)||0;
  const inkBonus=compactInkCompatible(ev,Math.min(3,axis.rows?.length||0))?Math.max(0,.16-Math.abs((ev?.medianNorm||1)-1)*.08):0;
  return .75+mean+min*.12+inkBonus+(empiricalStrong?.10:0);
}
function withDiag(axis,extra){return {...axis,diagnostics:{...(axis?.diagnostics||{}),r22FamilyArbitration:extra}}}
function rejectFrom(base,reason,diag){return {accepted:false,reason,diagnostics:{...(base?.diagnostics||{}),mode:'r22-family-arbitration-reject',r22FamilyArbitration:diag}}}


function compactFromPlotRows(img,plot){
  const projectionRows=finite(plot?.geometryGate?.projection?.horizontal?.allRows);
  const hs=[...new Set([...finite(plot?.h),...projectionRows].map(y=>Math.round(y)))].sort((a,b)=>a-b);
  if(hs.length<3||!Number.isFinite(plot?.left)||!Number.isFinite(plot?.vStep))return null;
  const vx=Math.max(1,Math.abs(Number(plot.vStep)||50)),cheap=[];
  // Crop/phone geometry can miss the X=0 vertical and report a neighbouring sample-grid
  // line as `left`. Test only the nearest physical lattice positions; numeric family is
  // still decided by row-local label morphology + empirical 3.0/2.0/1.0 glyph evidence.
  const halfStepMajor=!!plot?.geometryGate?.halfStepMajorRows;
  const axisXs=(halfStepMajor?
    [plot.left,plot.left-vx,plot.left-vx*1.2,plot.left-vx*1.4,plot.left-vx*1.5,plot.left-vx*1.6,plot.left-vx*.5,plot.left+vx*.5]:
    [plot.left,plot.left-vx,plot.left-vx*.5,plot.left+vx*.5])
    .filter(x=>x>55&&x<img.width-10);
  for(let i=0;i+2<hs.length;i++){
    const rr=hs.slice(i,i+3),d1=rr[1]-rr[0],d2=rr[2]-rr[1],st=(d1+d2)/2;
    if(!(st>24)||Math.abs(d1-d2)>Math.max(6,st*.18))continue;
    for(const axisX of axisXs){
      const q={accepted:true,rows:rr,values:[3,2,1],step:1,diagnostics:{mode:'r25-compact-plot-row-triplet-axis-neighbor',axisX,halfStepMajorRows:halfStepMajor}};
      const ev=inkEvidence(img,plot,q),nn=(ev?.norm||[]).slice(0,3).filter(Number.isFinite);
      const guarded2of3=nn.length===3&&nn.filter(x=>x>=.28&&x<=1.60).length>=2&&median(nn)<=1.58&&Math.max(...nn)<=1.95;
      if(!compactInkCompatible(ev,3)&&!guarded2of3)continue;
      const compactRows=nn.filter(x=>x>=.45&&x<=1.55).length;
      const morphScore=(ev?.medianNorm||0)-Math.abs(d1-d2)/Math.max(1,st)+compactRows*.05-Math.abs(axisX-plot.left)/vx*.015;
      cheap.push({q,ev,rr,st,morphScore});
    }
  }
  cheap.sort((a,b)=>b.morphScore-a.morphScore);
  // Empirical bank scoring is relatively expensive. Run it only for the strongest few
  // morphology/geometry proposals, and only in the center camera view. This remains a
  // confirmation gate: it cannot invent rows or numeric values.
  let best=null;
  for(const item of cheap.slice(0,halfStepMajor?12:6)){
    const {q,ev,rr,st}=item,pForGlyph={...plot,left:q.diagnostics.axisX},scores=[];
    let ok=true;
    for(let ri=0;ri<3;ri++){
      let bz=-Infinity;
      for(const dy of [-2,-1,0,1,2]){
        const row=Glyph.rowMask(img,pForGlyph,rr[ri]+dy,st,COMPACT_CENTER_VIEW);
        const z=CompactEvidence.scoreRow(row,['3.0','2.0','1.0'][ri],0);
        if(Number.isFinite(z)&&z>bz)bz=z;
      }
      if(!Number.isFinite(bz)||bz<0){ok=false;break} scores.push(bz);
    }
    if(!ok||scores.length!==3)continue;
    const empiricalMean=scores.reduce((a,b)=>a+b,0)/3,empiricalMin=Math.min(...scores);
    if(empiricalMean<.35||empiricalMin<.28)continue;
    q.diagnostics.empiricalMean=empiricalMean;q.diagnostics.empiricalMin=empiricalMin;
    const my=(rr[0]+rr[1]+rr[2])/3,mv=2;let num=0,den=0;
    for(let k=0;k<3;k++){num+=(rr[k]-my)*([3,2,1][k]-mv);den+=(rr[k]-my)*(rr[k]-my)}
    if(!(den>0))continue;q.slope=num/den;q.intercept=mv-q.slope*my;
    const score=halfStepMajor?
      (empiricalMean*.82+empiricalMin*.20-item.morphScore*.02-Math.abs((ev?.medianNorm||.8)-.8)*.06):
      (item.morphScore+empiricalMean*.30+empiricalMin*.08);
    if(!best||score>best.score)best={q,ev,score};
  }
  return best?.q||null;
}
function candidateGridAligned(axis,plot){
  if(!axis?.accepted||!Array.isArray(axis.rows)||axis.rows.length<2)return false;
  const hs=finite(plot?.h).sort((a,b)=>a-b);
  if(hs.length<2)return true;
  const ds=hs.slice(1).map((y,i)=>y-hs[i]).filter(d=>d>8),st=Number(plot?.hStep)>8?Number(plot.hStep):median(ds);
  if(!(st>8))return true;
  const tol=Math.max(5,st*.16);
  return axis.rows.every(y=>hs.some(h=>Math.abs(h-y)<=tol));
}

function visiblePairNearEnergyPlot(axis,plot){
  if(!axis?.accepted||!/decimal-visible-pair/i.test(String(axis.diagnostics?.mode||'')))return false;
  const rr=finite(axis.rows).sort((a,b)=>a-b);if(rr.length!==2)return false;
  const box=plot?.box||{},top=Number(box.top),bottom=Number(plot?.bottom??box.bottom),vs=Math.max(8,Number(plot?.vStep)||50);
  return Number.isFinite(top)&&Number.isFinite(bottom)&&rr[0]>=top-vs*.20&&rr[1]<=bottom+vs*.35;
}
function geometryFamilyNearEnergyPlot(axis,plot){
  // The dev37 rescue is specifically a two-label physical pair whose real
  // major rows can sit outside the denser crop-local lattice. Multi-row
  // geometry families must still align to the detected plot rows; otherwise
  // inferred outer rows can fabricate a 4-label family (IMG_2406 class).
  if(!axis?.accepted||!axis.diagnostics?.geometryFamilyFallback||(axis.values?.length||0)!==2)return false;
  const rr=finite(axis.rows).sort((a,b)=>a-b);if(rr.length!==2)return false;
  const box=plot?.box||{},top=Number(box.top),bottom=Number(plot?.bottom??box.bottom),vs=Math.max(8,Number(plot?.vStep)||50),hs=Math.max(vs,Number(plot?.hStep)||0);
  // A two-label physical-pair rescue exists precisely for cases where crop-local
  // geometry omitted the lower major Y row. Use Y-grid spacing, not Sample-X
  // spacing, for the allowed vertical overhang. Multi-row families never enter
  // this path, so lower-screen UI rows still cannot compose a 3/4-anchor family.
  return Number.isFinite(top)&&Number.isFinite(bottom)&&rr[0]>=top-hs*.80&&rr.at(-1)<=bottom+hs*1.05;
}
function physicalFourNearEnergyPlot(axis,plot){
  if(!axis?.accepted||axis.diagnostics?.mode!=='r25-dev65-decimal-four-physical-row-rescue')return false;
  const rr=finite(axis.rows).sort((a,b)=>a-b);if(rr.length!==4)return false;
  const box=plot?.box||{},top=Number(box.top),bottom=Number(plot?.bottom??box.bottom),vs=Math.max(8,Number(plot?.vStep)||50);
  return Number.isFinite(top)&&Number.isFinite(bottom)&&rr[0]>=top-vs*.55&&rr.at(-1)<=bottom+vs*.35;
}
function decimalCandidateLocated(axis,plot){return candidateGridAligned(axis,plot)||visiblePairNearEnergyPlot(axis,plot)||geometryFamilyNearEnergyPlot(axis,plot)||physicalFourNearEnergyPlot(axis,plot)}
function collectDecimal(img,plot,base){
  const out=[];const push=q=>{if(!q?.accepted||!isDecimal(q)||!decimalCandidateLocated(q,plot))return;const ev=inkEvidence(img,plot,q),s=decimalStrength(q,ev);if(Number.isFinite(s))out.push({q,ev,s})};
  push(base);
  try{push(R51.decimalSeriesFallback(img,plot))}catch(_e){}
  try{push(R51.decimalVisiblePairFallback(img,plot))}catch(_e){}
  // General search is intentionally last because it is slower and is not needed when
  // a row-local empirical decimal candidate already exists.
  if(!out.length)try{push(R51.decimalSearch(img,plot,base))}catch(_e){}
  // Completeness invariant: once a decimal candidate has independently supported
  // 3/4 monotone label+grid anchors, a nested shorter decimal family must not win only
  // because its local score is slightly higher.  Rank supported anchor count first.
  out.sort((a,b)=>{const na=a.q.values?.length||0,nb=b.q.values?.length||0;if(na!==nb&&(na>=3||nb>=3))return nb-na;return b.s-a.s});return out;
}
function collectCompact(img,plot,base){
  const out=[];const push=q=>{if(!q?.accepted||!isCompact(q))return;const ev=inkEvidence(img,plot,q),s=compactStrength(q,ev);if(Number.isFinite(s))out.push({q,ev,s})};
  push(base);
  if(!out.length)try{push(compactFromPlotRows(img,plot))}catch(_e){}
  try{push(R51.compactLabelPeakFallback(img,plot))}catch(_e){}
  try{push(R51.projectionPhaseCompactFallback(img,plot))}catch(_e){}
  out.sort((a,b)=>b.s-a.s);return out;
}
function chooseFamily(base,d,c){
  if(d&&c){
    let gap=d.s-c.s;
    const compactStrong=strongEmpiricalCompact(c.q,c.ev);
    const dRows=finite(d.q.rows).sort((a,b)=>a-b),cRows=finite(c.q.rows).sort((a,b)=>a-b);
    const cStep=cRows.length>=3?median(cRows.slice(1).map((y,i)=>y-cRows[i])):NaN;
    const decimalFarBelow=compactStrong&&d.q.values?.length===2&&Number.isFinite(cStep)&&dRows.length>=2&&dRows[0]>cRows.at(-1)+cStep*.55;
    const decimalOverspan=d.ev?.minNorm>2.65;
    // A second compact->decimal steal mode occurs when a spurious two-label decimal
    // pair brackets a real 3/2/1 triplet.  Geometry alone is not enough: require
    // independent compact empirical confirmation, regular compact spacing, and a
    // decimal pair span of roughly three compact steps.  This matches photographed
    // cases where UI/grid rows far above/below the numeric labels form a plausible
    // 0.01/0.005 pair while the actual 3.0/2.0/1.0 glyphs sit between them.
    const decimalSpan=dRows.length>=2?dRows.at(-1)-dRows[0]:NaN;
    const compactBracketed=compactStrong&&d.q.values?.length===2&&Number.isFinite(cStep)&&Number.isFinite(decimalSpan)&&
      decimalSpan>=cStep*2.65&&decimalSpan<=cStep*3.45&&
      cRows[0]>=dRows[0]-cStep*.45&&cRows.at(-1)<=dRows.at(-1)+cStep*.45;
    // If a strong 3/4-label decimal decoder and a compact decoder use the same
    // physical row lattice, but the compact hypothesis is obtained only by
    // shifting axisX left and reading cropped fragments of the longer decimal
    // labels, prefer the independently supported decimal family.
    const sameRowTriplet=compactStrong&&(d.q.values?.length||0)>=3&&dRows.length>=3&&cRows.length>=3&&Number.isFinite(cStep)&&
      dRows.slice(0,3).every((y,i)=>Math.abs(y-cRows[i])<=Math.max(5,cStep*.22));
    const dAxis=Number(d.ev?.axisX),cAxis=Number(c.ev?.axisX),vStep=Math.max(1,Number(d.ev?.vStep)||Number(c.ev?.vStep)||cStep||1);
    const decimalSameRowsStrong=sameRowTriplet&&d.ev?.minNorm>=1.55&&d.ev?.medianNorm>=1.65&&Number.isFinite(dAxis)&&Number.isFinite(cAxis)&&dAxis-cAxis>=vStep*.28;
    const d4Mode=/decimal-four-physical-row-rescue/i.test(String(d.q.diagnostics?.mode||'')),d4Mean=Number(d.q.diagnostics?.empiricalMean)||0,d4Min=Number(d.q.diagnostics?.minRow)||0;
    const d4Widths=(d.q.diagnostics?.labelWidths||[]).map(w=>w/Math.max(1,d.ev?.vStep||1)).sort((a,b)=>a-b);
    const decimalFourComplete=d4Mode&&(d.q.values?.length===4)&&d4Widths.length===4&&d4Widths[0]>=.72&&d4Widths[1]>=1.15&&median(d4Widths)>=1.35&&d4Mean>=.55&&d4Min>=.40;
    if(decimalFourComplete)gap=Math.max(.20,Math.abs(gap));
    else if(decimalSameRowsStrong)gap=Math.max(.20,Math.abs(gap));
    else if(compactStrong&&((decimalFarBelow&&decimalOverspan)||compactBracketed))gap=-Math.max(.20,Math.abs(gap));
    if(Math.abs(gap)<.12)return rejectFrom(base,'Y-axis numeric family is ambiguous between decimal and compact labels.',{decimal:{score:d.s,values:d.q.values,ink:d.ev},compact:{score:c.s,values:c.q.values,ink:c.ev}});
    const win=gap>0?d:c,q=win.q;
    if(gap<0&&isCompact(q))q.diagnostics={...(q.diagnostics||{}),compact:true,verifiedUnitStep:true};
    return withDiag(q,{winner:gap>0?'decimal':'compact',scoreGap:gap,compactAntiSteal:compactStrong&&decimalFarBelow&&decimalOverspan,decimal:d&&{score:d.s,values:d.q.values,ink:d.ev},compact:c&&{score:c.s,values:c.q.values,ink:c.ev}});
  }
  if(d)return withDiag(d.q,{winner:'decimal',decimal:{score:d.s,values:d.q.values,ink:d.ev},compact:null});
  if(c){c.q.diagnostics={...(c.q.diagnostics||{}),compact:true,verifiedUnitStep:true};return withDiag(c.q,{winner:'compact',decimal:null,compact:{score:c.s,values:c.q.values,ink:c.ev}});}
  return null;
}
function resolve(img,plot){
  // r25-dev59 bounded search order:
  // 1) exact-grid fast compact (cheap),
  // 2) complete 3/4-anchor decimal evidence (cheap),
  // 3) label-peak compact anti-steal for two-anchor decimal photos,
  // 4) visible decimal pair arbitration,
  // 5) projection/legacy only if all bounded evidence remains unresolved.
  const preC=[];const pushC=q=>{if(!q?.accepted||!isCompact(q))return;const ev=inkEvidence(img,plot,q),s=compactStrength(q,ev);if(Number.isFinite(s)&&strongEmpiricalCompact(q,ev))preC.push({q,ev,s})};
  const preD=[];const pushD=q=>{if(!q?.accepted||!isDecimal(q)||!decimalCandidateLocated(q,plot))return;const ev=inkEvidence(img,plot,q),s=decimalStrength(q,ev);if(Number.isFinite(s))preD.push({q,ev,s})};

  try{pushC(FastCompact.fastCompact321(img,plot))}catch(_e){}
  // Cheap regular plot-row compact evidence is evaluated before label-bank
  // searches.  The helper already requires regular 3-row spacing plus compact
  // row-local morphology (guarded 2-of-3 only for an ordinary adjacent triplet),
  // so it cannot win on geometry alone.
  if(!preC.length)try{pushC(compactFromPlotRows(img,plot))}catch(_e){}
  // Complete decimal families are safe to evaluate before the more expensive
  // label-peak compact search.  A 3/4-anchor monotone family has independent
  // completeness evidence that a nested two-anchor hypothesis cannot provide.
  try{pushD(R51.decimalSeriesFallback(img,plot))}catch(_e){}
  try{pushD(R51.decimalPhysicalFourAnchorFallback(img,plot))}catch(_e){}
  try{
    const g=R51.geometryFamilyFallback(img,plot),ev=g?.accepted?inkEvidence(img,plot,g):null;
    // Early geometry-family completion is intentionally limited to the tight
    // decimal morphology that motivated the perspective recovery. Extremely
    // wide three-row spans can be photographed compact labels merged with grid
    // ink (field_01 class); those must still face compact label-peak arbitration.
    if(!ev||!Number.isFinite(ev.medianNorm)||ev.medianNorm<=2.20||/decimal-pair-pseudo-third-reject/i.test(String(g?.diagnostics?.mode||'')))pushD(g);
  }catch(_e){}
  preD.sort((a,b)=>{const na=a.q.values?.length||0,nb=b.q.values?.length||0;if(na!==nb&&(na>=3||nb>=3))return nb-na;return b.s-a.s});
  if(!preC.length&&preD[0]&&(preD[0].q.values?.length||0)>=3){
    // Semantic anti-steal only: before a complete decimal family can
    // early-complete, give an exact regular plot-row compact hypothesis one
    // cheap chance to compete. Do not retain this fallback in ordinary
    // compact cases, where label-peak/projection evidence is more selective.
    try{pushC(compactFromPlotRows(img,plot))}catch(_e){}
    if(!preC.length)return chooseFamily(preD[0].q,preD[0],null);
  }

  if(!preC.length)try{pushC(R51.compactLabelPeakFallback(img,plot))}catch(_e){}
  // Two-label decimal evidence must still compete with compact morphology,
  // because photographed 3/2/1 labels can otherwise masquerade as 0.01/0.005.
  let rawVisiblePair=null;
  try{rawVisiblePair=R51.decimalVisiblePairFallback(img,plot);pushD(rawVisiblePair)}catch(_e){}
  preC.sort((a,b)=>b.s-a.s);preD.sort((a,b)=>{const na=a.q.values?.length||0,nb=b.q.values?.length||0;if(na!==nb&&(na>=3||nb>=3))return nb-na;return b.s-a.s});
  if(preC.length||preD.length){
    const pre=chooseFamily(preD[0]?.q||preC[0]?.q,preD[0],preC[0]);
    if(pre)return pre;
  }

  // r25-dev68 bounded release path.
  // The frozen release corpus is fully resolved by the evidence paths above
  // (fast compact, regular plot-row compact, compact label peak, complete decimal
  // series/four-anchor, visible decimal pair, and physical pair rebind).  The older
  // projection/legacy searches are orders of magnitude slower and, when bounded
  // evidence is already ambiguous, can turn an honestly unresolved photograph into
  // a late false acceptance.  Do not spend tens of seconds guessing.  Return
  // Needs attention and keep those legacy searches available only in archived
  // diagnostic modules, not in the release measurement path.
  // Preserve the narrow physical-pair repair handoff used by the priority
  // 0.01000/0.00500 case: one decoded row is attached to a real plot row while
  // the companion label was bound to the wrong geometry row.  Return the pair as
  // an explicit rejected candidate (never Accepted here) so pipeline37 can rebind
  // it to independently detected physical horizontal rows.  Cases where neither
  // decoded row touches the plot lattice stay on the bounded Needs-attention path.
  if(rawVisiblePair?.accepted&&(rawVisiblePair.values?.length||0)===2&&visiblePairNearEnergyPlot(rawVisiblePair,plot)){
    const rr=finite(rawVisiblePair.rows);
    const q={...rawVisiblePair,accepted:false,diagnostics:{...(rawVisiblePair.diagnostics||{}),latticeRows:[...rr]}};
    return rejectFrom(q,'Two-label decimal candidate requires physical grid-row rebind.',{physicalPairHandoff:true,baseInk:inkEvidence(img,plot,rawVisiblePair)});
  }
  return {accepted:false,reason:'Bounded Y-axis evidence is unresolved; manual attention is required.',diagnostics:{
    mode:'r25-dev68-bounded-axis-unresolved',
    compactCandidates:preC.map(x=>({values:x.q.values,rows:x.q.rows,mode:x.q.diagnostics?.mode,score:x.s})),
    decimalCandidates:preD.map(x=>({values:x.q.values,rows:x.q.rows,mode:x.q.diagnostics?.mode,score:x.s}))
  }};
}
module.exports={resolve,inkEvidence,decimalInkStrong,compactInkCompatible,debugCompactFromPlotRows:compactFromPlotRows};

},
'core_v2_axis_resolver50_fast_safe.js': function(module,exports,require){
'use strict';
const Base=require('./core_v2_axis_resolver49_broken_rank_evidence.js');
const AX=require('./core_v2_axis_consensus2.js');
function sameAnchors(diag){const A=diag?.anchors;if(!Array.isArray(A)||A.length!==3||A.some(x=>!Array.isArray(x)||x.length<2))return null;const canon=A[0].map(a=>({y:a.y,value:a.value,text:a.text}));for(let v=1;v<3;v++){if(A[v].length!==canon.length)return null;for(let i=0;i<canon.length;i++)if(Math.abs(A[v][i].y-canon[i].y)>1||Math.abs(A[v][i].value-canon[i].value)>1e-9)return null}return canon}
function resolve(img,plot){const out=Base.resolve(img,plot);if(out.accepted||out.reason!=='axis hypothesis margin too small')return out;const d=out.diagnostics||{},m=d.margin||[],steps=d.step||[],xs=d.axisX||[],anchors=sameAnchors(d);if(!anchors||m.length!==3||m.some(x=>!(x>=.015))||m.reduce((a,b)=>a+b,0)<.05)return out;if(steps.some(x=>!Number.isFinite(x))||Math.max(...steps)-Math.min(...steps)>Math.max(...steps)*.02)return out;if(xs.some(x=>!Number.isFinite(x))||Math.max(...xs)-Math.min(...xs)>1.25)return out;const fit=AX.fitAffine(anchors),st=steps.reduce((a,b)=>a+b,0)/3;if(!(fit.slope<0)||fit.rmse/Math.max(st,1e-12)>.08)return out;return{accepted:true,rows:anchors.map(a=>a.y),values:anchors.map(a=>a.value),slope:fit.slope,intercept:fit.intercept,step:st,normRmse:fit.rmse/Math.max(st,1e-12),spacingCv:0,views:3,worstValueSteps:0,worstStepLogRatio:0,diagnostics:{...d,mode:'v41-cross-view-fast',crossViewMargin:true,aggregateMargin:m.reduce((a,b)=>a+b,0)}}}
module.exports={resolve};

},
'core_v2_axis_resolver49_broken_rank_evidence.js': function(module,exports,require){
'use strict';
const PRIMARY=require('./core_v2_axis_resolver38_memo_primary.js');
const FB=require('./core_v2_axis_resolver34g_inkcenter_preserve_memo.js');
const AX=require('./core_v2_axis_consensus2.js');
const GC=require('./core_v2_axis_glyph_candidate4_preserve_strokes.js');
const CE=require('./core_v2_compact_empirical_evidence.js');
const VIEWS=[{gmin:48,diff:6,ratio:1.06,lum:28,empiricalView:0},{gmin:50,diff:8,ratio:1.08,lum:30,empiricalView:1},{gmin:52,diff:8,ratio:1.08,lum:30,empiricalView:2}];


function fastCompact321(img,plot){
  if(!Array.isArray(plot.h)||plot.h.length!==3||!Number.isFinite(plot.left))return null;
  const rows=[...plot.h].filter(Number.isFinite).sort((a,b)=>a-b),stepPx=plot.hStep||((rows[2]-rows[0])/2);
  if(rows.length!==3||!(stepPx>10))return null;
  const seqs=[['3.0','2.0','1.0'],['4.0','3.0','2.0'],['2.0','1.0','0.0']];
  const valueSeq=[[3,2,1],[4,3,2],[2,1,0]],sols=[];
  for(let vi=0;vi<VIEWS.length;vi++){
    const view=VIEWS[vi],scores=[];
    for(let si=0;si<seqs.length;si++){
      const anchors=[];let total=0,empMin=1,empSum=0;
      for(let k=0;k<3;k++){
        let best=null;
        for(const dy of [-2,-1,0,1,2]){
          const y=rows[k]+dy,row=GC.rowMask(img,plot,y,stepPx,view),z=GC.detail(row,seqs[si][k]),emp=CE.scoreRow(row,seqs[si][k],vi);
          if(!z||!Number.isFinite(emp))continue;
          const score=z.score*.35+emp*.65+.08*(z.charMean||0);
          if(!best||score>best.score)best={score,z,emp,y};
        }
        if(!best||best.z.score<.43||best.emp<.38){anchors.length=0;break}
        total+=best.score;empMin=Math.min(empMin,best.emp);empSum+=best.emp;
        anchors.push({y:rows[k],value:valueSeq[si][k],conf:Math.min(best.z.score,best.emp),text:seqs[si][k],charMean:best.z.charMean||0,empirical:best.emp,labelY:best.y});
      }
      if(anchors.length===3){
        const fit=AX.fitAffine(anchors),mean=empSum/3;
        scores.push({si,total:total+anchors.length*.22-fit.rmse*.35,anchors,fit,empiricalMean:mean,empiricalMin:empMin});
      }
    }
    scores.sort((a,b)=>b.total-a.total);if(!scores.length||scores[0].si!==0)return null;
    const best=scores[0],alt=scores[1],margin=alt?best.total-alt.total:99;
    if(margin<.10||best.empiricalMean<.50||best.empiricalMin<.45)return null;
    sols.push({slope:best.fit.slope,intercept:best.fit.intercept,step:1,support:3,score:best.total,anchors:best.anchors,axisX:plot.left,rows:rows.map((y,k)=>({y,labelY:best.anchors[k].labelY,gridIndex:k,base:stepPx})),margin,alt:alt?{step:1,score:alt.total,anchors:alt.anchors}:null});
  }
  if(sols.length!==3)return null;
  const out=AX.consensus(sols,{minViews:3,maxViewValueSteps:.05,maxViewStepLogRatio:.02,minMargin:.10,maxAnchorSpreadSteps:.05,maxNormRmse:.05,maxSpacingCv:.18});
  if(!out.accepted)return null;
  const emp=sols.flatMap(q=>q.anchors.map(a=>a.empirical)),empiricalMean=emp.reduce((a,b)=>a+b,0)/emp.length,empiricalMin=Math.min(...emp);
  return{...out,empiricalMean,empiricalMin,axisX:plot.left,sols,diagnostics:{mode:'r8-fast-compact-321',compact:true,verifiedUnitStep:true,axisX:plot.left,empiricalMean,empiricalMin}};
}

function compactAt(img,plot,opt={}){
  if(Array.isArray(plot.h)&&plot.h.length===3){
    const aspects=plot.h.map(y=>GC.labelAspect(GC.rowMask(img,plot,y,plot.hStep||30,VIEWS[1]))).filter(Number.isFinite);
    const good=aspects.filter(a=>a>=.65&&a<=2.55).length,med=aspects.length?[...aspects].sort((a,b)=>a-b)[aspects.length>>1]:0;
    if(good<2||med<.78)return null;
  }
  if(!opt.disableFast){const fast=fastCompact321(img,plot);if(fast)return fast;}
  const raw=VIEWS.map(v=>FB.solveViewCompactUnit(img,plot,{...v,forceAxisX:plot.left}));
  const sols=raw.filter(Boolean);
  if(sols.length<2)return null;
  if(sols.some(s=>s.anchors.length!==3||Math.abs(s.step-1)>1e-9||s.margin<.018))return null;
  const sig=s=>s.anchors.map(a=>`${Math.round(a.y)}:${a.text}`).join('|');
  if(new Set(sols.map(sig)).size!==1)return null;
  const out=AX.consensus(sols,{minViews:2,maxViewValueSteps:.05,maxViewStepLogRatio:.02,minMargin:.018,maxAnchorSpreadSteps:.05,maxNormRmse:.05,maxSpacingCv:.18});
  if(!out.accepted)return null;
  const vals=sols[0].anchors.map(a=>a.value);
  if(vals.some(v=>v<0||v>20.000001||Math.abs(v-Math.round(v))>1e-9))return null;
  const empAll=sols.flatMap(z=>z.anchors.map(a=>a.empirical||0)),empiricalMean=empAll.reduce((a,b)=>a+b,0)/empAll.length,empiricalMin=Math.min(...empAll);
  if(empiricalMin<.28||empiricalMean<.40)return null;
  return{...out,empiricalMean,empiricalMin,axisX:sols.map(s=>s.axisX).sort((a,b)=>a-b)[Math.floor(sols.length/2)],sols};
}
function compactAxisCandidates(img,plot){
  const st=Math.max(10,plot.vStep||30),lo=Math.max(0,Math.round(plot.left-3.2*st)),hi=Math.min(img.width-1,Math.round(plot.left+2.7*st));
  const edges=[];
  for(const y0 of (plot.h||[])){
    let runs=[],a=-1;
    for(let x=lo;x<=hi;x++){
      let ok=false;
      for(let dy=-12;dy<=12&&!ok;dy++){
        const y=Math.round(y0+dy);if(y<0||y>=img.height)continue;
        const i=(y*img.width+x)*4;if(GC.green(img.data[i],img.data[i+1],img.data[i+2],VIEWS[1]))ok=true;
      }
      if(ok&&a<0)a=x;
      if((!ok||x===hi)&&a>=0){const b=ok?x:x-1;if(b-a+1>=3&&b-a+1<=Math.max(55,st*.9))runs.push(b);a=-1}
    }
    edges.push(runs);
  }
  const clusters=[];
  for(const arr of edges)for(const e of arr){
    let q=clusters.find(c=>Math.abs(c.center-e)<=7);
    if(!q){q={center:e,ys:new Set(),vals:[]};clusters.push(q)}
    q.vals.push(e);q.center=q.vals.reduce((a,b)=>a+b,0)/q.vals.length;q.ys.add(edges.indexOf(arr));
  }
  const out=[plot.left,...[-1.25,-1,-.75,-.5,-.25,.25,.5,.75,1,1.25,1.5,1.75,2].map(k=>plot.left+st*k)];
  for(const q of clusters.filter(q=>q.ys.size>=2).sort((a,b)=>b.ys.size-a.ys.size)){
    for(const gap of [4,8,12])out.push(q.center+gap);
  }
  return [...new Set(out.map(x=>Math.round(x*2)/2))].filter(x=>x>=55&&x<img.width-20).slice(0,10);
}
function compactFallback(img,plot){
  if(!Array.isArray(plot.h)||plot.h.length!==3)return{accepted:false,reason:'compact-axis requires exactly three field-verified rows'};
  // Recover X=0 from repeated Y-label ink when the geometry window is shifted.
  // Only a few label-derived candidates are evaluated, avoiding a slow blind X sweep.
  const hs=[...(plot.h||[])].filter(Number.isFinite).sort((a,b)=>a-b),rs=plot.hStep||30;
  const ranked=compactAxisCandidates(img,plot).map(left=>{
    let ss=[];
    for(let i=0;i<Math.min(3,hs.length);i++){
      const row=GC.rowMask(img,{...plot,left,right:left+10*(plot.vStep||30)},hs[i],rs,VIEWS[1]);
      const z=CE.scoreRow(row,['3.0','2.0','1.0'][i],1);if(Number.isFinite(z))ss.push(z);
    }
    return{left,pre:ss.length?ss.reduce((a,b)=>a+b,0)/ss.length:0};
  }).sort((a,b)=>b.pre-a.pre).slice(0,6);
  const cands=[];
  for(const r of ranked){
    const left=r.left,q=compactAt(img,{...plot,left,right:left+10*(plot.vStep||30)});
    if(q)cands.push({...q,pre:r.pre,searchLeft:left,searchOffset:(left-plot.left)/Math.max(1,plot.vStep||30)});
  }
  if(!cands.length)return{accepted:false,reason:'compact-axis views did not all resolve'};
  cands.sort((a,b)=>(b.empiricalMean-a.empiricalMean)||(b.support-a.support));
  const best=cands[0],alt=cands.find(q=>Math.abs(q.axisX-best.axisX)>Math.max(3,(plot.vStep||30)*.18));
  if(Math.abs(best.searchOffset)>.22)return{accepted:false,reason:'compact-axis X=0 shifted too far inside plot'};
  if(alt&&best.empiricalMean-alt.empiricalMean<.018)return{accepted:false,reason:'compact-axis X=0 search is ambiguous'};
  return{...best,diagnostics:{mode:'v55-compact-label-axis-search',compact:true,verifiedUnitStep:true,axisX:best.axisX,searchOffset:best.searchOffset,empiricalMean:best.empiricalMean,alternative:alt?{axisX:alt.axisX,empiricalMean:alt.empiricalMean}:null,sols:best.sols.map(s=>({step:s.step,margin:s.margin,axisX:s.axisX,anchors:s.anchors}))}};
}
function fallback(img,plot){
  const sols=VIEWS.map(v=>FB.solveView(img,plot,v));
  if(sols.some(s=>!s))return{accepted:false,reason:'broken-grid fallback views did not all resolve'};
  if(sols.some(s=>s.rows.length!==2||s.anchors.length!==2))return{accepted:false,reason:'broken-grid fallback requires exactly two readable labels'};
  const texts=sols.map(s=>s.anchors.map(a=>a.text).join('|'));
  if(new Set(texts).size!==1)return{accepted:false,reason:'broken-grid fallback label values disagree'};
  if(sols.some(s=>s.anchors.some(a=>!Number.isInteger(a.rank)||a.rank>1)))return{accepted:false,reason:'broken-grid fallback label rank evidence too weak'};for(let i=0;i<2;i++)if(!sols.some(s=>s.anchors[i].rank===0))return{accepted:false,reason:'broken-grid fallback has no top-ranked support for a label'};if(sols.reduce((q,s)=>q+s.anchors.reduce((u,a)=>u+a.rank,0),0)>2)return{accepted:false,reason:'broken-grid fallback aggregate rank evidence too weak'};
  const rows0=sols[0].rows.map(r=>r.y);
  for(const s of sols)for(let i=0;i<2;i++)if(Math.abs(s.rows[i].y-rows0[i])>2)return{accepted:false,reason:'broken-grid fallback row positions disagree'};
  const steps=sols.map(s=>s.step),st=steps.slice().sort((a,b)=>a-b)[1];
  if(Math.max(...steps.map(x=>Math.abs(x-st)/Math.max(st,1e-12)))>.03)return{accepted:false,reason:'broken-grid fallback step disagreement'};
  const vals=sols[0].anchors.map(a=>a.value); if(!(vals[0]>vals[1]&&vals[1]>=0))return{accepted:false,reason:'broken-grid fallback non-descending axis'};
  const anchors=rows0.map((y,i)=>({y,value:vals[i],conf:Math.min(...sols.map(s=>s.anchors[i].conf))}));
  if(anchors.some(a=>a.conf<.68))return{accepted:false,reason:'broken-grid fallback label confidence too low'};
  const fit=AX.fitAffine(anchors); if(!(fit.slope<0))return{accepted:false,reason:'broken-grid fallback affine validation failed'};
  return{accepted:true,rows:rows0,values:vals,slope:fit.slope,intercept:fit.intercept,step:st,normRmse:fit.rmse/Math.max(st,1e-12),spacingCv:0,views:3,worstValueSteps:0,worstStepLogRatio:0,diagnostics:{mode:'v49-broken-grid-cross-view-rank-evidence',fallback:true,sols:sols.map(s=>({step:s.step,margin:s.margin,rows:s.rows.map(r=>({y:r.y,labelY:r.labelY})),anchors:s.anchors}))}};
}
function resolve(img,plot){
  const p=PRIMARY.resolve(img,plot);
  if(p.accepted){p.diagnostics={...(p.diagnostics||{}),mode:'v49-broken-grid-cross-view-rank-evidence',fallback:false};return p}
  const vr=p.diagnostics?.viewResolved;
  if(Array.isArray(vr)&&vr.length===3&&vr.every(Boolean)){
    return{...p,diagnostics:{...(p.diagnostics||{}),mode:'v49-broken-grid-cross-view-rank-evidence',fallback:false,fallbackSkipped:'all primary views already resolved'}};
  }
  const f=fallback(img,plot); if(f.accepted)return f;
  const c=compactFallback(img,plot); if(c.accepted)return c;
  return{...p,diagnostics:{...(p.diagnostics||{}),mode:'v52-multiformat-axis',fallbackAttempt:f.reason,compactFallbackAttempt:c.reason}};
}
module.exports={resolve,fallback,compactFallback,compactAxisCandidates,compactAt,fastCompact321};

},
'core_v2_axis_resolver38_memo_primary.js': function(module,exports,require){
'use strict';
const C=require('./core_v2_axis_gui_candidate9_memo.js');
const AX=require('./core_v2_axis_consensus2.js');
const DEC=[];for(let i=0;i<=40;i++){const v=i*.005;DEC.push({text:(Math.abs(v)<5e-10?0:v).toFixed(5),value:v,formatSig:'fixed:5'})}
function longestRun(row){let b=0,c=0;for(const z of row){c=z?c+1:0;if(c>b)b=c}return b}
function refineAxisX(img,plot,view={}){const W=img.width,H=img.height,d=img.data,lo=Math.max(0,Math.floor(plot.left-18)),hi=Math.min(W-1,Math.ceil(plot.left+10)),rec=[];for(let x=lo;x<=hi;x++){let best=0,cur=0;for(let y=0;y<H;y++){const i=(y*W+x)*4,ok=C.green(d[i],d[i+1],d[i+2],view);cur=ok?cur+1:0;if(cur>best)best=cur}rec.push({x,run:best})}rec.sort((a,b)=>b.run-a.run);if(!rec.length||rec[0].run<30)return null;const thr=Math.max(30,rec[0].run*.68),xs=rec.filter(r=>r.run>=thr).map(r=>r.x).sort((a,b)=>a-b);let groups=[],g=[];for(const x of xs){if(!g.length||x-g[g.length-1]<=2)g.push(x);else{groups.push(g);g=[x]}}if(g.length)groups.push(g);groups.sort((a,b)=>b.length-a.length);const q=groups[0];return q.reduce((s,x)=>s+x,0)/q.length}
function readableRows(img,plot,view={}){const W=img.width,H=img.height,d=img.data,x0=Math.max(0,Math.round(plot.left)),x1=Math.min(W-1,Math.round(plot.right)),old=plot.h||[],lo=Math.max(0,Math.floor((old.length?Math.min(...old):0)-90)),hi=Math.min(H-1,Math.ceil((old.length?Math.max(...old):H-1)+30)),cand=[];for(let y=lo;y<=hi;y++){const row=[];let sum=0;for(let x=x0;x<=x1;x++){const i=(y*W+x)*4,z=C.green(d[i],d[i+1],d[i+2],view)?1:0;row.push(z);sum+=z}const run=longestRun(row);if(run>=Math.max(30,(x1-x0)*.34))cand.push({y,run,sum})}const groups=[];for(const r of cand){if(!groups.length||r.y-groups.at(-1).at(-1).y>2)groups.push([r]);else groups.at(-1).push(r)}const reps=groups.map(g=>g.sort((a,b)=>b.run-a.run)[0]).sort((a,b)=>a.y-b.y);if(reps.length<2)return[];const diffs=[];for(let i=1;i<reps.length;i++)diffs.push(reps[i].y-reps[i-1].y);const base=diffs.length?diffs.sort((a,b)=>a-b)[Math.floor(diffs.length/2)]:0;return reps.map((r,i)=>({...r,gridIndex:i,base}))}
function niceStep(x){if(!(x>1e-7&&x<10))return false;const mag=10**Math.floor(Math.log10(x)),m=x/mag;return Math.min(...[1,2,2.5,5,10].map(q=>Math.abs(m-q)/q))<=.06}
function solveView(img,plot,view){const ax=refineAxisX(img,plot,view);if(!Number.isFinite(ax))return null;const p={...plot,left:ax};const rows=readableRows(img,p,view);if(rows.length<2)return null;const stepPx=rows.length>1?(rows.at(-1).y-rows[0].y)/(rows.length-1):30;const masks=rows.map(r=>C.rowMask(img,p,r.y,stepPx,view)),aspects=masks.map(C.labelAspect).filter(Number.isFinite);const aspect=aspects.length?aspects.sort((a,b)=>a-b)[Math.floor(aspects.length/2)]:NaN;if(!(aspect>=2.8))return null;const pools=masks.map(m=>C.guiScorePool(m,DEC,16));const rankMaps=pools.map(pool=>new Map(pool.map((q,idx)=>[q.text,idx])));const hyps=[];for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){const di=rows[j].gridIndex-rows[i].gridIndex;for(const a of pools[i])for(const b of pools[j]){const st=(a.value-b.value)/di;if(!(st>0)||!niceStep(st))continue;const pred=[];for(let k=0;k<rows.length;k++){const val=a.value-st*(rows[k].gridIndex-rows[i].gridIndex),text=(Math.abs(val)<5e-10?0:val).toFixed(5);if(val<-1e-9||val>.200001)continue;pred.push({k,val,text,styles:C.styleMap(masks[k],text)})}if(pred.length<2)continue;const styleKeys=new Set();for(const q of pred)for(const key of q.styles.keys())styleKeys.add(key);let bestStyle=null;for(const key of styleKeys){let total=0,support=0,anchors=[];for(const q of pred){const z=q.styles.get(key);if(!z||z.score<.43)continue;support++;total+=z.score;anchors.push({y:rows[q.k].y,value:q.val,conf:z.score,text:q.text})}if(support<2)continue;let rankBonus=0;for(const an of anchors){const k=rows.findIndex(r=>Math.abs(r.y-an.y)<.5),rk=k>=0?rankMaps[k].get(an.text):undefined;if(rk===0)rankBonus+=.018;else if(rk===1)rankBonus+=.012;else if(rk===2)rankBonus+=.006;}const fit=AX.fitAffine(anchors),score=total*1.28+support*.08+rankBonus;if(!bestStyle||score>bestStyle.score)bestStyle={score,support,anchors,fit,style:key,rankBonus}}if(!bestStyle)continue;hyps.push({slope:bestStyle.fit.slope,intercept:bestStyle.fit.intercept,step:st,support:bestStyle.support,score:bestStyle.score,anchors:bestStyle.anchors,style:bestStyle.style,rankBonus:bestStyle.rankBonus,axisX:ax,rows,aspect})}}
  hyps.sort((a,b)=>b.score-a.score);if(!hyps.length)return null;const best=hyps[0],second=hyps.find(h=>Math.abs(h.step-best.step)>best.step*.05||Math.abs((h.intercept-best.intercept)/(best.step||1))>.15);best.margin=second?best.score-second.score:99;best.alt=second?{step:second.step,score:second.score,anchors:second.anchors}:null;return best}
function resolve(img,plot){const views=[{gmin:46,diff:6,ratio:1.06,lum:28},{gmin:50,diff:8,ratio:1.08,lum:30},{gmin:52,diff:8,ratio:1.08,lum:30}],sols=views.map(v=>solveView(img,plot,v));const out=AX.consensus(sols,{minViews:3,maxViewValueSteps:.12,maxViewStepLogRatio:.08,minMargin:.018,maxAnchorSpreadSteps:.12,maxNormRmse:.08,maxSpacingCv:.16});out.diagnostics={mode:'affine-gui-style-rank-nonnegative-observation-v32',viewResolved:sols.map(Boolean),step:sols.map(s=>s?.step??null),margin:sols.map(s=>s?.margin??null),axisX:sols.map(s=>s?.axisX??null),rows:sols.map(s=>s?.rows?.map(r=>r.y)??[]),anchors:sols.map(s=>s?.anchors??[])};return out}
module.exports={resolve,solveView,refineAxisX,readableRows};

},
'core_v2_axis_gui_candidate9_memo.js': function(module,exports,require){
'use strict';
const BASE=require('./core_v2_axis_glyph_candidate2.js');
const BANK=require('./core_v2_gui_numeric_bank.js');
const decoded=new Map();
const rowCache=new WeakMap();
const detailCache=new WeakMap();
function unpack(t){let k=t.family+':'+t.size+':'+t.w+'x'+t.h+':'+t.bits;if(decoded.has(k))return decoded.get(k);const b=(typeof Buffer!=='undefined'&&Buffer.from)?Buffer.from(t.bits,'base64'):(()=>{const s=atob(t.bits),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u})(),a=new Uint8Array(t.w*t.h),ones=[];for(let i=0;i<a.length;i++){const v=(b[i>>3]>>(i&7))&1;a[i]=v;if(v)ones.push([i%t.w,Math.floor(i/t.w)])}const z={...t,data:a,ones,tc:ones.length};decoded.set(k,z);return z}
function rowStats(row){let z=rowCache.get(row);if(z)return z;const stride=row.w+1,ii=new Uint32Array((row.w+1)*(row.h+1));for(let y=0;y<row.h;y++){let rs=0;for(let x=0;x<row.w;x++){rs+=row.data[y*row.w+x]?1:0;ii[(y+1)*stride+(x+1)]=ii[y*stride+(x+1)]+rs}}z={ii,stride};rowCache.set(row,z);return z}
function rectSum(st,x,y,w,h){const {ii,stride}=st,x2=x+w,y2=y+h;return ii[y2*stride+x2]-ii[y*stride+x2]-ii[y2*stride+x]+ii[y*stride+x]}
function templateScore(row,t){t=unpack(t);if(t.h>row.h||t.w>row.w)return null;const st=rowStats(row),tc=t.tc;if(tc<5)return null;let best=null;const xlo=Math.max(0,row.w-t.w-18),xhi=row.w-t.w;for(let yy=0;yy<=row.h-t.h;yy++)for(let x=xlo;x<=xhi;x++){let tp=0;for(const [dx,dy] of t.ones)if(row.data[(yy+dy)*row.w+x+dx])tp++;const obs=rectSum(st,x,yy,t.w,t.h),rec=tp/tc,prec=tp/Math.max(1,obs),score=.70*rec+.30*prec;if(!best||score>best.score)best={score,rec,prec,x,yy,family:t.family,size:t.size}}return best}
function guiDetails(row,text){let m=detailCache.get(row);if(!m){m=new Map();detailCache.set(row,m)}if(m.has(text))return m.get(text);const ts=BANK[text];if(!ts){m.set(text,[]);return []}const out=[];for(const t of ts){const z=templateScore(row,t);if(z)out.push(z)}out.sort((a,b)=>b.score-a.score);m.set(text,out);return out}
function guiDetail(row,text){return guiDetails(row,text)[0]||null}
function styleMap(row,text){const m=new Map();for(const z of guiDetails(row,text))m.set(z.family+':'+z.size,z);return m}
function guiScorePool(row,pool,limit=14){const out=[];for(const c of pool){const z=guiDetail(row,c.text);if(z)out.push({...c,score:z.score,gui:z})}out.sort((a,b)=>b.score-a.score);return out.slice(0,limit)}
module.exports={...BASE,guiDetail,guiDetails,styleMap,guiScorePool,templateScore};

},
'core_v2_axis_glyph_candidate2.js': function(module,exports,require){
'use strict';
const FONT={'0':["11111","10001","10011","10101","11001","10001","11111"],'1':["00100","01100","00100","00100","00100","00100","01110"],'2':["11110","00001","00001","11110","10000","10000","11111"],'3':["11110","00001","00001","01110","00001","00001","11110"],'4':["10010","10010","10010","11111","00010","00010","00010"],'5':["11111","10000","10000","11110","00001","00001","11110"],'6':["01111","10000","10000","11110","10001","10001","01110"],'7':["11111","00001","00010","00100","01000","01000","01000"],'8':["01110","10001","10001","01110","10001","10001","01110"],'9':["01110","10001","10001","01111","00001","00001","11110"],'.':["0","0","0","0","0","0","1"],'-':["00000","00000","00000","11111","00000","00000","00000"]};
function green(r,g,b,v={}){const mx=Math.max(r,b);return g>(v.gmin??42)&&(g-mx)>=(v.diff??5)&&g>=mx*(v.ratio??1.05)&&(.299*r+.587*g+.114*b)>(v.lum??28)}
function rasterText(text,gap=1){let gs=[],ranges=[],ox=0;for(const ch of text){const q=FONT[ch];if(q)gs.push(q)}const H=7,W=gs.reduce((s,g)=>s+g[0].length,0)+gap*Math.max(0,gs.length-1),a=new Uint8Array(W*H);for(let gi=0;gi<gs.length;gi++){const g=gs[gi],st=ox;for(let y=0;y<H;y++)for(let x=0;x<g[y].length;x++)if(g[y][x]==='1')a[y*W+ox+x]=1;ox+=g[0].length;ranges.push([st,ox-1]);if(gi<gs.length-1)ox+=gap}return{data:a,w:W,h:H,ranges}}
function scaled(t,sc){const w=Math.max(1,Math.round(t.w*sc)),h=Math.max(1,Math.round(t.h*sc)),a=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=Math.min(t.w-1,Math.floor(x/sc)),sy=Math.min(t.h-1,Math.floor(y/sc));a[y*w+x]=t.data[sy*t.w+sx]}return{data:a,w,h,ranges:t.ranges.map(([a,b])=>[Math.floor(a*sc),Math.min(w-1,Math.ceil((b+1)*sc)-1)])}}
function rowMask(img,plot,y,rowStep,view={}){const W=img.width,H=img.height,d=img.data,rs=Math.max(12,rowStep||28),x1=Math.max(2,Math.round(plot.left-(view.xGap??4))),span=Math.max(48,Math.min(70,Math.round((plot.right-plot.left)*(view.spanFrac??.34)))),x0=Math.max(0,x1-span),half=Math.max(8,Math.min(15,Math.round(rs*(view.halfFrac??.40)))),y0=Math.max(0,Math.round(y-half)),y1=Math.min(H-1,Math.round(y+half)),w=x1-x0+1,h=y1-y0+1,a=new Uint8Array(w*h);for(let yy=y0;yy<=y1;yy++)for(let x=x0;x<=x1;x++){if(Math.abs(yy-y)<=1)continue;const i=(yy*W+x)*4;if(green(d[i],d[i+1],d[i+2],view))a[(yy-y0)*w+(x-x0)]=1}return{data:a,w,h,x0,y0}}
function detail(row,text){let best=null;for(const gap of [1,2]){const rb=rasterText(text,gap);for(const sc of [1,1.25,1.5,1.75,2,2.25,2.5,2.75,3]){const t=scaled(rb,sc);if(t.h>row.h*.94||t.w>row.w*.99)continue;const yc=Math.floor(row.h/2),yMin=Math.max(0,Math.round(yc-t.h*.78)),yMax=Math.min(row.h-t.h,Math.round(yc-t.h*.18));for(let yy=yMin;yy<=yMax;yy++)for(let off=0;off<=12;off++){const x=row.w-t.w-off;if(x<0)continue;let tp=0,obs=0,tc=0;for(let y=0;y<t.h;y++)for(let xx=0;xx<t.w;xx++){const tv=t.data[y*t.w+xx],ov=row.data[(yy+y)*row.w+(x+xx)];if(tv)tc++;if(ov)obs++;if(tv&&ov)tp++}if(tc<4)continue;const rec=tp/tc,prec=tp/Math.max(1,obs),score=rec*.7+prec*.3;if(!best||score>best.score)best={score,rec,prec,x,yy,t,sc,gap}}}}if(!best)return null;let chars=[];for(const [a,b] of best.t.ranges){let tp=0,tc=0,obs=0;for(let y=0;y<best.t.h;y++)for(let xx=a;xx<=b;xx++){const tv=best.t.data[y*best.t.w+xx],ov=row.data[(best.yy+y)*row.w+(best.x+xx)];if(tv)tc++;if(ov)obs++;if(tv&&ov)tp++}const rec=tp/Math.max(1,tc),prec=tp/Math.max(1,obs);chars.push(.7*rec+.3*prec)}best.charMean=chars.length?chars.reduce((s,v)=>s+v,0)/chars.length:0;best.charScores=chars;return best}
function score(row,text){return detail(row,text)?.score||0}
function scorePool(row,pool,limit=12){const out=[];for(const c of pool){const z=detail(row,c.text);if(z)out.push({...c,score:z.score,charMean:z.charMean})}out.sort((a,b)=>(b.score+.18*b.charMean)-(a.score+.18*a.charMean));return out.slice(0,limit)}
function labelAspect(row){const cols=new Int16Array(row.w);for(let y=0;y<row.h;y++)for(let x=0;x<row.w;x++)if(row.data[y*row.w+x])cols[x]++;let runs=[],a=-1,gap=0;for(let x=0;x<row.w;x++){if(cols[x]){if(a<0)a=x;gap=0}else if(a>=0){gap++;if(gap>Math.max(3,Math.round(row.h*.22))){runs.push([a,x-gap]);a=-1;gap=0}}}if(a>=0)runs.push([a,row.w-1]);if(!runs.length)return NaN;let q=runs.sort((u,v)=>v[1]-u[1])[0],ys=[];for(let y=0;y<row.h;y++)for(let x=q[0];x<=q[1];x++)if(row.data[y*row.w+x])ys.push(y);if(!ys.length)return NaN;return(q[1]-q[0]+1)/(Math.max(...ys)-Math.min(...ys)+1)}
module.exports={rowMask,detail,score,scorePool,labelAspect,green};

},
'core_v2_gui_numeric_bank.js': function(module,exports,require){
'use strict';
module.exports={"-0.05000":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIgSRLMmIV5nmHG7M3zfDNmeZ5nmDHD8zyDBGmWJAk8eZ7neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAHH53A4sMEm2Gw2iCASRCIRRhh5o9EII4zk0Wj8EUbgaDSCCCJQJBJBBpksk8nAEcfjcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAGOD4fDARvYDGw2G4hAJCASiUAMYh+xWAxjGNuMx2MYwxhsPB7/GMZg4/EYRCAaE4lEYAObjc1mAw5zODgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8fjw8HrCBjYGNzQbEIGYgJhYDIQj5CAmFYAhDZkPDIRjCENDQcPiEIAQkJBQCMYgNiYnFwCxmZmZmM+AZDw8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAGH53AcyCATZLIMI4yc0TjCCCNvNI4wwggajSOMMIJH4/gjjODROIIMMkgmy8AR5+FwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOj8PhABFEBJFIBEQQGUQiERhj7BmPx2CMMW48HoMxxrDxePzGGIPG4zEQQQQSiURAJBFEJBIBjjkODocD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcPA4OB5jAhGBiMgExiBnExGIwhjHP2HgMxjAGGxuPwRjGQGPj8RvDGHhsPAZiEAOJicXARCYiE5MJ8JjHw8PjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAHHx+FwYINNYLPZIIJIIBKJIILIIxKJL4IIJhKJIIIIJBKJYIMNZrPZwBHHw+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Hx4eD0zAZGBiMoEYiA3ExGIQA7GHmFgMYiCGEROLXwzEYGJiMYiBGExMLAYTM8mYmEzAYzwPHh4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4/PDw8AAzMDNgZmYGjMDIgJGRERAGYR/CwsJAGITBCAsLP2EQBiIsLAyMwAiIkZERMDMzMWZmZoDHeHjw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAHHx+FwYINNYLPZIIJIIBKJIILIIxKJIIJIJhKJJ4IIJBKJYINNZrPZwDHHw+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Hx4PD0zAJGAyMYEYiAXEYmIQA7GPWEwMYiA2EYuJXwzEYGIxMYiBGEwsJgYTM4mZTEzAYzweHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4/Hjw8IAZMBMwY2YGRsBIwIiREQgBIR8hQkIgDITNhAkLvxAQAhIiJARGwEjIiJERmDEzMzNmZsDDeHh48PAA"}],"-0.04500":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHDPM8DCRImSBLMmDlhnmHGrHnzfDPmTZ5nmDH/8DyDBAmbJQk8eZjneQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAEH8nE4sMGGCWw2iCDCBCIRRhhRntEII4wk2Wj8EUYTaDSCCKI/JBJBBhkkk8nAEQfycDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOgI/DARvYYAw2G4hAhCMQiUAMYhyfWAxjGNPYxmMYw9gGPB7/GMYz4PEYRCD6G4tEYAMbjM1mAw5zYDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":11,"bits":"AAAAIAAAAOABD4wfjwdsYINjYLMBMYjhGIjFQAhCND5CIRjCkI3ZcAiGMDQDNBw+IQj9AQmFQAxiMENiMTCLGYyZ2Qx4xgPDw+MB"},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAEH4nEcyCDDBLIMI4woxzjCCCPKM44wwkiCjCOMMIpg4/gjjH7YOIIMMggiy8ARB3pwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOhMfhABFEGIJIBEQQYQwiERhjTPGMx2CMMQQ3HoMxxhLYePzGGEdA4zEQQfQHiURAJBEEIhIBjjkQB4cD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcMB4OB5jABEZgMgExiOEMxGIwhjGax3gMxjBGgxmPwRjGZCDj8RvDWAxsPAZiEPuDiMXARCYwEZMJ8JgH5sHjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAEH4+NwYIMNI7DZIIKIIhCJIILI4hGJL4JIAhOJIILoDxKJYIMNArPZwBEH4uFw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8GB8eD0zAhGNgMoEYiHkMxGIQAzGNh1gMYiC2gRGLXwzEMmBiMYiB+A9MLAYTM8HImEzAYzwYDx4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4YPjx8AAzMMNhYGYGjMAIhYGRERAGYRI+wsJAGIRNgAkLP2EQFgEkLAyMwOgfkJERMDMzEGJmZoDHeEDw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAEH4+NwYIMNI7DZIIKIIhCJIIJI4hGJIILoLxOJJ4IIAhKJYIMNIrPZwDGH5+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8GB8PD0zAhCMwMYEYiGkEYmIQAzGNT0wMYiCWMYmJXwzEf2AxMYiBGAYsJgYTM8GITUzAYzw8Hg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4YPzw8IAZMMMRYGYGRsCIR4CREQgBIRofQkIgDIRlzAgLvxAQ+gciJARGwAhGiJERmDEzGDNmZsDDePB58PAA"}],"-0.04000":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHDPM8DCRImSRLMmLl5nmHGrM3zfDPmbZ5nmDH/8zyDBAmTJAk8eZjneQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAEH4nA4sMGG2Ww2iCDCRCIRRhhRo9EII4yk0Wj8EUbTaDSCCKJ/JBJBBhkkk8nAEQficDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOAIfDARvYYGw2G4hAhCMSiUAMYhyxWAxjGNOMx2MYw9hmPB7/GMYz4/EYRCD6E4lEYAMbjM1mAw5zYDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":11,"bits":"AAAAIAAAAOABDwwPjwdsYINjY7MBMYjhiInFQAhCNEJCIRjCkM3QcAiGMDQzNBw+IQj9CQmFQAxiMGJiMTCLGYyZ2Qx4xgPDw+MB"},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAEH4nAcyCDDZLIMI4yo0TjCCCNqNI4wwkgajSOMMIpG4/gjjP7ROIIMMkgmy8ARB+JwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOhMPhABFEGJFIBEQQYUQiERhjTBmPx2CMMWQ8HoMxxpLxePzGGEfG4zEQQfQXiURAJBFEJBIBjjkQDocD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcMA4OB5jABGZiMgExiOHExGIwhjHa2HgMxjBGGxuPwRjGZGPj8RvDWGxsPAZiEPuLicXARCYwE5MJ8JgHxsPjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAEHw+FwYIMNY7PZIIKIIhKJIILIIhKJL4JIIhKJIILoLxKJYIMNYrPZwBEHwuFw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8GB4eD0zAhGNiMoEYiHnExGIQAzGNmFgMYiC2EROLXwzEMmJiMYiB+E9MLAYTM8GYmEzAYzwYHh4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4YPDw8AAzMMNhZmYGjMAIhZGRERAGYRLCwsJAGIRNCAsLP2EQFiEsLAyMwOifkZERMDMzEGZmZoDHeEDw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAEHw+FwYIMNY7PZIIKIIhKJIIJIIhKJIILoLxKJJ4IIIhKJYIMNYrPZwDGHx+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8GB4PD0zAhGMyMYEYiGnEYmIQAzGNWEwMYiCWEYuJXwzEf2IxMYiBGEYsJgYTM8GYTEzAYzw8Hg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4YHjw8IAZMMMxY2YGRsCIx4iREQgBIRohQkIgDIRlhAkLvxAQ+hciJARGwAjGiJERmDEzGDNmZsDDePB58PAA"}],"-0.03500":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIkSBLMmCFhnmHGzHnzfDNmTJ5nmDHD8DyDBGmeJQk8eZ7neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAHH83E4sMEmC2w2iCCSBSIRRhjBntEII4ww2Wj8EUYwaDSCCKIRJBJBBtksk8nAEcfzcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOh4/DARvYbAw2G4hAJCIQiUAMYhCfWAxjGOPYxmMYwxgGPB7/GMZg4PEYRCAaG4tEYAObiM1mAw5zPDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8PH48HrCBjZ2BzQbEICZmIBYDIQiB+QiFYAhDOGbDIRjCEBzQcPiEIAQEJBQCMYgNDYnFwCxmZmZmM+AZDw8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAHH43EcyCCTBLIMI4wgxzjCCCPEM44wwoiDjCOMMIJh4/gjjGDYOIIMMggiy8ARx3lwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOh8fhABFEMoJIBEQQwQwiERhjDPGMx2CMMQc3HoMxxjDYePzGGINA4zEQQQQCiURAJBEIIhIBjjkOB4cD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcHB4OB5jAREZgMgExiIEMxGIwhjGIx3gMxjCGgxmPwRjGYCDj8RvDGBhsPAZiEAOBiMXARCYgEZMJ8JjH48HjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAGH4+NwYINNJrDZIIIIJhCJIIKI4xGJL4IIBhOJIIIIBBKJYINNBrPZwBHH4+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Hh8eD0zAJGJgMoEYiMEMxGIQAzGIh1gMYiDmgRGLXwzEYGBiMYiBGAxMLAYTM4nJmEzAYzwfDx4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4ePjx8AAzMDNjYGYGjMAIjIGRERAGYTA+wsJAGIR5gAkLP2EQBgMkLAyMwAgIkJERMDMzMWJmZoDHeHjw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAGH4+NwYINNJrDZIIIIJhCJIIKI4xGJIIIIJhOJJ4IIBBKJYINNJrPZwDHH4+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Hh8PD0zAJCIwMYEYiMEEYmIQAzGMT0wMYiDGMImJXwzEYGAxMYiBGAwsJgYTM4mJTUzAYzwfHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4ePzw8IAZMDMTYGYGRsBITICREQgBIRwfQkIgDITBzAgLvxAQAgIiJARGwEhIiJERmDEzMzNmZsDDeHh48PAA"}],"-0.03000":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIkSRLMmKF5nmHGzM3zfDNmbJ5nmDHD8zyDBGmWJAk8eZ7neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAHH43A4sMEm22w2iCCSRSIRRhjBo9EII4yw0Wj8EUbwaDSCCKJRJBJBBtksk8nAEcfjcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOB4fDARvYbGw2G4hAJCISiUAMYhCxWAxjGOOMx2MYwxhmPB7/GMZg4/EYRCAaE4lEYAObiM1mAw5zPDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8PDw8HrCBjZ2NzQbEICYmJhYDIQiBCQmFYAhDOEPDIRjCENzQcPiEIAQkJBQCMYgNiYnFwCxmZmZmM+AZDw8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAHH43AcyCCTZLIMI4yg0TjCCCNkNI4wwogbjSOMMIJH4/gjjODROIIMMkgmy8ARx+FwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOh8PhABFEMpFIBEQQwUQiERhjDBmPx2CMMWc8HoMxxrDxePzGGIPG4zEQQQQSiURAJBFIJBIBjjkODocD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcHA4OB5jARGZiMgExiIHExGIwhjHI2HgMxjCGGxuPwRjGYGPj8RvDGHhsPAZiEAOJicXARCYgE5MJ8JjHw8PjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAGHw+FwYINNZrPZIIIIJhKJIIKIIxKJL4IIJhKJIIIIJBKJYINNZrPZwBHHw+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Hh4eD0zAJGJiMoEYiMHExGIQAzGImFgMYiDmEROLXwzEYGJiMYiBGExMLAYTM4mZmEzAYzwfHh4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4ePDw8AAzMDNjZmYGjMAIjJGRERAGYTDCwsJAGIR5CAsLP2EQBiMsLAyMwAiIkZERMDMzMWZmZoDHeHjw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAGHw+FwYINNZrPZIIIIJhKJIIKIIxKJIIIIJhKJJ4IIJBKJYINNZrPZwDHHw+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Hh4PD0zAJGIyMYEYiMHEYmIQAzGMWEwMYiDGEIuJXwzEYGIxMYiBGEwsJgYTM4mZTEzAYzwfHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4eHjw8IAZMDMzY2YGRsBIzIiREQgBIRwhQkIgDITBhAkLvxAQAhIiJARGwEjIiJERmDEzMzNmZsDDeHh48PAA"}],"-0.02500":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIsSBLMmGdhnmHGDHnzfDNmRp5nmDEb8DyDBGmYJQk8eb/neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAGH83E4sMEmC2w2iCAaBSIRRhiBntEII4wg2Wj8EUYMaDSCCCIDJBJBBtkgk8nAEef3cDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOj4/DARvYTAw2G4hAJCYQiUAMYjGfWAxjGMPYxmMYwxgDPB7/GMYM4PEYRCAyGItEYAPbgM1mAw5z/jgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8PH48HrCBjZmBzQbEICZkIBYDIQgJ+QiFYAhDYGbDIRjCEA7QcPiEIMQAJBQCMYgZDInFwCxmAmZmM+AZzx8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAHH43EcyCCTBLIMI4xgxzjCCCPIM44wwgiCjCOMMEJg4/gjjAjYOIIMMgAiy8ARx39wHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOh8fhABFEMoJIBEQQxQwiERhjDPOMx2CMMQw3HoMxxhDYePzGGCNA4zEQQUQAiURAJJEQIhIBjjk+B4cD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcHB4OB5jAREZgMgExiIUMxGIwhjGQx3gMxjAGghmPwRjGICDj8RvDGAJsPAZiECOAiMXARCZEEZMJ8JjH78HjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAHH4+NwYINNJrDZIIIIJBCJIIII5hGJL4IIAxOJIIKIARKJYIPNALPZwBHH5+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Dx8eD0zAJGNgMoEYiMEMxGIQAzGIh1gMYiCGgRGLXwzEGGBiMYiBmAFMLAYTMxnImEzAYzw/Dx4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4ePjx8AAzMBNjYGYGjMAIjIGRERAGYTA+wsJAGIRhgAkLP2EQxgAkLAyMwIgBkJERMDMzA2JmZoDHePzw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAHH4+NwYINNJrDZIIIIJhCJIIII4hGJIIIIIxOJJ4KIARKJYIPNJLPZwDHH5+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Dx8PD0zAJCMwMYEYiEEEYmIQAzGIT0wMYiCGMYmJXwzEGGAxMYiBmAEsJgYTMxmJTUzAYzw/Hg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4ePzw8IAZMDMTYGYGRsBITICREQgBITAfQkIgDIRBzAgLvxAQggAiJARGwAhBiJERmDEzIjNmZsDDePx48PAA"}],"-0.02000":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIsSRLMmOd5nmHGDM3zfDNmZp5nmDEb8zyDBGmQJAk8eb/neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAGH43A4sMEm22w2iCAaRSIRRhiBo9EII4yg0Wj8EUbMaDSCCCJDJBJBBtkgk8nAEefncDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOD4fDARvYTGw2G4hAJCYSiUAMYjGxWAxjGMOMx2MYwxhjPB7/GMYM4/EYRCAyEIlEYAPbgM1mAw5z/jgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8PDw8HrCBjZmNzQbEICYkJhYDIQgJCQmFYAhDYEPDIRjCEM7QcPiEIMQgJBQCMYgZiInFwCxmAmZmM+AZzx8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAHH43AcyCCTZLIMI4zg0TjCCCNoNI4wwggajSOMMEJG4/gjjIjROIIMMkAmy8ARx+dwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOh8PhABFEMpFIBEQQxUQiERhjDBuPx2CMMWw8HoMxxpDxePzGGCPG4zEQQUQQiURAJJFQJBIBjjk+DocD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcHA4OB5jARGZiMgExiIXExGIwhjHQ2HgMxjAGGhuPwRjGIGPj8RvDGGJsPAZiECOIicXARCZEE5MJ8JjHz8PjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAHHw+FwYINNZrPZIIIIJBKJIIIIJhKJL4IIIxKJIIKIIRKJYIPNYLPZwBHHx+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Dx4eD0zAJGNiMoEYiMHExGIQAzGImFgMYiCGEROLXwzEGGJiMYiBmEFMLAYTMxmYmEzAYzw/Hh4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4ePDw8AAzMBNjZmYGjMAIjJGRERAGYTDCwsJAGIRhCAsLP2EQxiAsLAyMwIiBkZERMDMzA2ZmZoDHePzw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAHHw+FwYINNZrPZIIIIJhKJIIIIIhKJIIIIIxKJJ4KIIRKJYIPNZLPZwDHHx+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Dx4PD0zAJGMyMYEYiEHEYmIQAzGIWEwMYiCGEYuJXwzEGGIxMYiBmEEsJgYTMxmZTEzAYzw/Hg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4eHjw8IAZMDMzY2YGRsBIzIiREQgBITAhQkIgDIRBhAkLvxAQghAiJARGwAjBiJERmDEzIjNmZsDDePx48PAA"}],"-0.01500":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MFDPM8DCZIjSBLMmBlhnmHGjHjzfDNmRJ5nmDEj8DyDBAmZJQk8eYjneQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAEH8XE4sMGGCGw2iCByBCIRRhghntEII4wQ2Wj8EUYIaDSCCCIEJBJBBhkik8nAEQfxcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOgI/DARvYMAw2G4hA5CEQiUAMYgyfWAxjGGPYxmMYwxgDPB7/GMYY4PEYRCDCGItEYAMbhs1mAw5zMDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8EH48HrCBDYeBzQbEIOZhIBYDIQhh+AiFYAhDGGbDIRjCEAbQcPiEIIQBJBQCMYhhDInFwCxmGGZmM+AZDwYPjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAGH4XEcyCBjBLIMI4wQxzjCCCPEM44wwgiBjCOMMEJg4/gjjBDYOIIMMgQiy8ARh3lwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOgsfhABFEDIJIBEQQIQwiERhjjPCMx2CMMQI3HoMxxgjYePzGGCNA4zEQQYQAiURAJBECIhIBjjkcB4cD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcGB4OB5jABENgMgExiGEMxGIwhjGMx3gMxjCGgRmPwRjGMCDj8RvDGAZsPAZiEMOAiMXARCYYEZMJ8JiH48HjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAHH4eNwYIMNIbDZIIIIIRCJIIII4RGJL4IIAROJIIIIARKJYIMNAbPZwBHH5+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Dx8eD0zAhGFgMoEYiDEMxGIQAzGGh1gMYiDGgBGLXwzEGGBiMYiBGANMLAYTM2HImEzAYzw/Dx4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4PPjx8AAzMINgYGYGjMAIgoGRERAGYQg+wsJAGIQhgAkLP2EQhgAkLAyMwAgCkJERMDMzCGJmZoDHePzw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAGH4eNwYINNIbDZIIIIIRCJIIII4RGJIIIIIROJJ4IIARKJYIMNIbPZwDHH5+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Dh8PD0zApCEwMYEYiDEEYmIQAzGGT0wMYiDGMImJXwzEGGAxMYiBGAMsJgYTM2GITUzAYzweHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4MPzw8IAZMOMQYGYGRsAIQ4CREQgBIQwfQkIgDIQxzAgLvxAQwgAiJARGwAhDiJERmDEzDDNmZsDDePh48PAA"}],"-0.01000":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MFDPM8DCZIjSRLMmJl5nmHGjMzzfDNmZJ5nmDEj8zyDBAmRJAk8eYjneQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAEH4XA4sMGG2Gw2iCByRCIRRhgho9EII4yQ0Wj8EUbIaDSCCCJEJBJBBhkik8nAEQfhcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOAIfDARvYMGw2G4hA5CESiUAMYgyxWAxjGGOMx2MYwxhjPB7/GMYY4/EYRCDCEIlEYAMbhs1mAw5zMDgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8EDw8HrCBDYeNzQbEIOYhJhYDIQhhCAmFYAhDGEPDIRjCEMbQcPiEIIQhJBQCMYhhiInFwCxmGGZmM+AZDwYPjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAGH4XAcyCBjZLIMI4yQ0TjCCCNkNI4wwggZjSOMMEJG4/gjjJDROIIMMkQmy8ARh+FwHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOgsPhABFEDJFIBEQQIUQiERhjjBiPx2CMMWI8HoMxxojxePzGGCPG4zEQQYQQiURAJBFCJBIBjjkcDocD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcGA4OB5jABGNiMgExiGHExGIwhjHM2HgMxjCGGRuPwRjGMGPj8RvDGGZsPAZiEMOIicXARCYYE5MJ8JiHw8PjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAHHweFwYIMNYbPZIIIIIRKJIIIIIRKJL4IIIRKJIIIIIRKJYIMNYbPZwBHHx+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Dx4eD0zAhGFiMoEYiDHExGIQAzGGmFgMYiDGEBOLXwzEGGJiMYiBGENMLAYTM2GYmEzAYzw/Hh4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4PPDw8AAzMINgZmYGjMAIgpGRERAGYQjCwsJAGIQhCAsLP2EQhiAsLAyMwAiCkZERMDMzCGZmZoDHePzw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAGHweFwYINNYbPZIIIIIRKJIIIIIRKJIIIIIRKJJ4IIIRKJYIMNYbPZwDHHx+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Dh4PD0zApGEyMYEYiDHEYmIQAzGGWEwMYiDGEIuJXwzEGGIxMYiBGEMsJgYTM2GYTEzAYzweHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4MHjw8IAZMOMwY2YGRsAIw4iREQgBIQwhQkIgDIQxhAkLvxAQwhAiJARGwAjDiJERmDEzDDNmZsDDePh48PAA"}],"-0.00500":[{"family":"NimbusSans","size":11,"w":43,"h":8,"bits":"4MHzPM8DCZIkSBLMmGdhnmHGPHvzfDPmWZ5nmDHP8DyDBEmaJQk8eZ7neQ=="},{"family":"NimbusSans","size":12,"w":47,"h":9,"bits":"wAGH83E4sMFmC2w2iCASBSIRRhiNntEII4xG2Wj8EUYjaDSCCCIRJBJBBpksk8nAEYfzcDg="},{"family":"NimbusSans","size":13,"w":51,"h":10,"bits":"wAEOh4/DARvYbAw2G4hAJCIQiUAMYjGfWAxjGI/ZxmMYw3gMPB7/GMZj4PEYRCASGYtEYAObjc1mAw5zODgcDg=="},{"family":"NimbusSans","size":14,"w":54,"h":10,"bits":"gAc8PH48HrCBjY2BzQbEICZmIBYDIQgJ+QiFYAhDQ2bDIRjC0BDQcPiEICQEJBQCMYiJDYnFwCxmZmZmM+AZDw8Pjwc="},{"family":"NimbusRoman","size":13,"w":46,"h":9,"bits":"wAGH43EcyCCTBbIMI4xGxzjCCKPRM44wwmiEjCOMMBph4/gjjEbYOIIMMhkiy8ARh3twHA=="},{"family":"NimbusRoman","size":14,"w":50,"h":10,"bits":"gAMOh8fhABFEIoJIBEQQiQwiERhjPPaMx2CM8Rg3HoMxxmPYePzGGI9B4zEQQSQCiURAJJEIIhIBjjkcB4cD"},{"family":"NimbusRoman","size":15,"w":53,"h":10,"bits":"gAMcHB4OB5jAxERgMgExiIkNxGIwhrGxx3gMxjA2hhmPwRjGxiDj8RvD2BhsPAZiEBODiMXARCYmEZMJ8JiH58HjAQ=="},{"family":"DejaVuSans","size":11,"w":48,"h":8,"bits":"wAGH4+NwYIPNJrDZIIJIJBCJIIJI5BGJL4JIBBOJIIJIBBKJYIPNBrPZwBGH4+Fw"},{"family":"DejaVuSans","size":12,"w":53,"h":9,"bits":"wAM8Hh8eD0zAZGJgMoEYiMUMxGIQA7GYh1gMYiAWgxGLXwzEYmBiMYiBWAxMLAYTM5nImEzAYzweDx4P"},{"family":"DejaVuSans","size":13,"w":58,"h":9,"bits":"gAd4ePjx8AAzMDNjYGYGjMDIiIGRERAGYWE+wsJAGISFgQkLP2EQFgYkLAyMwMgIkJERMDMzM2JmZoDHeHjw8PAA"},{"family":"DejaVuSerif","size":11,"w":48,"h":8,"bits":"wAGH4+NwYIPNJrDZIIJIJBCJIIJI5BGJIIJIJBOJJ4JIBBKJYIPNJrPZwDGH4+Fw"},{"family":"DejaVuSerif","size":12,"w":53,"h":9,"bits":"wAM8Hh8PD0zAZCIwMYEYiMUEYmIQA7GYT0wMYiAWM4mJXwzEYmAxMYiBWAwsJgYTM5mITUzAYzweHg8P"},{"family":"DejaVuSerif","size":13,"w":58,"h":9,"bits":"wAN4ePzw8IAZMDMTYGYGRsDISICREQgBISEfQkIgDISFzQgLvxAQEgIiJARGwMhIiJERmDEzMzNmZsDDeHh48PAA"}],"0.00000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkiSTPmeTbPM+Z5Ns8z5nk2zzPmeTbPEiRJIkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4DoezwWbbbLYIIlEkEkcYjaPROMJoHI3GEUbjaDSKIBJFIlEGmSyTyRxxOA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwODgcG9hsNjabCEQiEZFIDGKxmFg8hvF4bDwew3g8Nh6PYTweG49FIBKJiEQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNxsbGJgZiMTExsRAIhYSEhEMwHBoaGg7BcGhoaCgEQiEhIaEYiMXExMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAcjsPJIMtkmTzCOBpH4wjjaByNI4yjcTSOMI7G0TjCOBpHowyyTJbJHHEcjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCEQikUgkApFIJBKNYTwej8djGI/H4/EYxuPxeDyG8Xg8HotAJBKJRCIRiUQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcHA4JjAxmZhMYhATi4nFYxgbj43HYxgbj43HYxgbj43HYxgbj43HYhATi4nFJjIxmZhMPObh8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA4HA63gc1ms9kRiEQikRiBSCQSiRGIRCKRGIFIJBKJG9hsNpvtCIfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmExMMYiJicXEMYiJicXEMYiJicXEMYiJicXEMYiJicXEE5uYmExMHvPw8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwYmRkZBQGYcLCwsJhECYsLCwcBmHCwsLCIzBiZGRkNDMzZmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4HA63gc1ms9kRiEQikRiBSCQSiRGIRCKRGIFIJBKJG9hsNpvtGIfD4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmExMMYiJicXEMYiJicXEMYiJicXEMYiJicXEMYiJicXEE5uYmExMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwYmRkZBQCIUJCQkJhECYsLCwcAiFCQkJCIzBiZGRkNDMzZmZmZh7jwcPDwwM="}],"0.00500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkgSTPmWTDPM+bZM88z5lk2zzPmGTbPEiRpJkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4H4ezwWYLbLYIIlEgEkcYjZ7ROMJolI3GEUYjaDSKIBJBIlEGmSyTyRxxOA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwfDgcG9hsBjabCEQiAZFIDGKxj1g8hvHYZjwew3gMNh6PYTwGG49FIBKNiUQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNxsDGJgZiMQMxsRAIhXyEhEMwHDIbGg7BcAhoaCgEQiEgIaEYiMWGxMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAcnsPJIMsEmTzCOHJG4wjjyBuNI4wjaDSOMI7g0TjCOIJHowyyDJLJHHGch8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBweByOCEQigkgkApHIIBKNYTz2jMdjGI9x4/EYxmPYeDyG8Rg0HotAJAKJRCIRiSAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODg8HA4JjAxEZhMYhATG4jFYxgbe4zHYxgbw4zHYxgbg4zHYxgbg43HYhATg4jFJjIxiZhMPObhefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA4Pg63gc0msNkRiEQCkRiBSOQRiRGIRDCRGIFIBBKJG9hsMJvtCIfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYGExMMYiJGcTEMYiJecTEMYiJwcTEMYiJgcXEMYiJgcXEE5uYyExMHvPweHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgZmZiMwYmRgZBQGYcI+wsJhECYMJiwcBmHCQMLCIzBiBGRkNDMzZmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4Pg63gc0msNkRiEQCkRiBSOQRiRGIRDKRGIFIBBKJG9hsMpvtGIfj4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYCExMMYiJCcTEMYiJ+cTEMYiJmcTEMYiJgcXEMYiJgcXEE5uYiE1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgJmZiMwYiRgZBQCIUI+QkJhECZsJiwcAiFCQEJCIzBiJGRkNDMzZmZmZh7jwcPDwwM="}],"0.01000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzE43kSJEciSTNmZjbPM2ZkNs8zZmQ2zzNmZDbPEiREIkmePMTjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHAQDoezwYbYbLYIIkckEkcYIaPROMIIGY3GEUbIaDSKIEJEIlEGGSKTyRxxEA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOAAODgcG9gwNjabCEQeEZFIDGKMmFg8hjFmbDwewxgzNh6PYYwZG49FIMKIiEQ2sGFsbDaOcTAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMCD4OHh2YCNw8bGJgZiDzExsRAIMYSEhEMwxBgaGg7BEGNoaCgEQgwhIaEYiDHExMRmYsYwMzPzGA+Dh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAMjsPJIDNkmTzCiBhH4wgjYhyNI4yIcTSOMCLG0TjCiBhHowwyQpbJHHEMjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOAgOByOCEQMkUgkAhFCJBKNYYwYj8djGCPG4/EYxojxeDyGMWI8HotAhBCJRCIRIUQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODAcHA4JjDBmJhMYhDDiInFYxjDjI3HYxjDjI3HYxjDjI3HYxjDjI3HYhDDiInFJjLBmJhMPObh8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnAcHA63gQ1hs9kRiBAikRiBCCESiRGIECKRGIEIIRKJG9gQNpvtCMfH4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvB48Hh4E5hgmExMMYhhiMXEMYhhiMXEMYhhiMXEMYhhiMXEMYhhiMXEE5tgmExMHvP48Xh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDhwcPDMwMzEGZmZiMwAmFkZBQGYRDCwsJhEAYhLCwcBmEQwsLCIzACYWRkNDMzEGZmZh7j4cfDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnAYHA63gU1hs9kRiBAikRiBCCESiRGIECKRGIEIIRKJG9gQNpvtGMfH4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvBw8Hh4E5homExMMYhhiMXEMYhhiMXEMYhhiMXEMYhhiMXEMYhhiMXEE5tgmExMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuCBwcPDMwMzHGZmZiMwgmFkZBQCIRhCQkJhEIYhLCwcAiEYQkJCIzCCYWRkNDMzGGZmZh7jwcfDwwM="}],"0.01500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzE43kSJEcgSTNmRjDPM2bEM88zZkQ2zzNmBDbPEiRkJkmePMTjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHAQH4ezwYYIbLYIIkcgEkcYIZ7ROMIIkY3GEUYIaDSKIEJAIlEGGSKTyRxxEA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOAAfDgcG9gwBjabCEQeAZFIDGKMj1g8hjHGZjwewxgDNh6PYYwBG49FIMKMiUQ2sGFsbDaOcTAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMCD8OPh2YCNw8DGJgZiDwMxsRAIMXyEhEMwxDAbGg7BEANoaCgEQgwgIaEYiDGGxMRmYsYwMzPzGA+Dh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAMnsPJIDMEmTzCiHBG4wgjwhuNI4wIaDSOMCLg0TjCiIBHowwyApLJHHGMh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOAgeByOCEQMgkgkAhHCIBKNYYzwjMdjGCNw4/EYxgjYeDyGMQI0HotAhACJRCIRISAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODA8HA4JjDBEJhMYhDDGIjFYxjDeIzHYxjDwIzHYxjDgIzHYxjDgI3HYhDDgIjFJjLBiJhMPObhePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnAcPg63gQ0hsNkRiBACkRiBCOERiRGIEDCRGIEIARKJG9gQMJvtCMfn4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvB4+Hh4E5hgGExMMYhhGMTEMYhheMTEMYhhwMTEMYhhgMXEMYhhgMXEE5tgyExMHvP4eXh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDh4cfDMwMzEAZmZiMwAmFgZBQGYRA+wsJhEAYBJiwcBmEQQMLCIzACAWRkNDMzEGJmZh7j4cfDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnAYPg63gU0hsNkRiBACkRiBCOERiRGIEDKRGIEIARKJG9gQMpvtGMfn4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvBw+Hh4E5hoCExMMYhhCMTEMYhh+MTEMYhhmMTEMYhhgMXEMYhhgMXEE5tgiE1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuCB4cfDMwMzHAJmZiMwgiFgZBQCIRg+QkJhEIZhJiwcAiEYQEJCIzCCIWRkNDMzGGZmZh7jwcfDwwM="}],"0.02000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJFkiSTPmeTbPM2ZoNs8zZmY2zzNmYzbPEqRBIkmevN/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4DoezwSbbbLYIolEkEkcYgaPROMIIGo3GEUbMaDSKIDJEIlEG2SCTyRxxfg6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HODwODgcG9hMNjabCERiEZFIDGKxmFg8hjFsbDwewxgzNh6PYcwYG49FIDKIiEQ2sA1sbDaOcf4cHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNzMbGJgZiITExsRAIhYSEhEMwBBsaGg7BEGdoaCgEQgYhIaEYiA3ExMRmYhYwMzPzGO+Ph4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAejsPJIEtkmTzCCBtH4wgjZByNI4yQcTSOMCLG0TjCSBhHowwyQJbJHHE+jsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCEQykUgkAlFMJBKNYQwbj8djGMPG4/EYxpDxeDyGMWI8HotARBCJRCIRCUUiEcc4Pg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcHA4JjCRmZhMYhALiYnFYxgDjY3HYxgDjY3HYxiDjI3HYxhDjI3HYhAjiInFJjIhmphMPObx8/B4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA8HA63gU1ms9kRiEAikRiBCCYSiRGIMCKRGIGIIRKJG9gMNpvtCMfH4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvB48Hh4E5jImExMMYiBicXEMYiBiMXEMYjBiMXEMYhhiMXEMYgxiMXEE5sYmExMHvP48Xh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzYmZmZiMwAmZkZBQGYWDCwsJhEAYjLCwcBmEYwsLCIzDCYGRkNDMzBmZmZh7j4cfDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA8HA63gU1ms9kRiGAikRiBCCISiRGIMCKRGIGIIRKJG9hMNpvtGMfH4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvB48Hh4E5jImExMMYiBiMXEMYiBiMXEMYjBiMXEMYhhiMXEMYgxiMXEE5sYmUxMHvP48Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwImZkZBQCIWBCQkJhEAYiLCwcAiEQQkJCIzCCYGRkNDMzRGZmZh7j4cfDwwM="}],"0.02500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJFkgSTPmWTDPM2bIM88zZkY2zzNmAzbPEqRhJkmevN/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4H4ezwSYLbLYIolEgEkcYgZ7ROMIIko3GEUYMaDSKIDJAIlEG2SCTyRxxfg+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HODwfDgcG9hMBjabCERiAZFIDGKxj1g8hjHMZjwewxgDNh6PYcwAG49FIDKMiUQ2sA1sbDaOcf4cHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNzMDGJgZiIQMxsRAIhXyEhEMwBDMbGg7BEAdoaCgEQgYgIaEYiA2GxMRmYhYwMzPzGO+Ph4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAensPJIEsEmTzCCHNG4wgjxBuNI4wQaDSOMCLg0TjCSIBHowwyAJLJHHG+h8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBweByOCEQygkgkAlHMIBKNYQzzjMdjGMNw4/EYxhDYeDyGMQI0HotARACJRCIRCSEiEcc4PgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODg8HA4JjCREZhMYhALGYjFYxgDeYzHYxgDwYzHYxiDgIzHYxhDgI3HYhAjgIjFJjIhiphMPObxe/B4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA8Pg63gU0msNkRiEACkRiBCOYRiRGIMDCRGIGIARKJG9gMMJvtCMfn4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvB4+Hh4E5jIGExMMYiBGcTEMYiBeMTEMYjBwMTEMYhhgMXEMYgxgMXEE5sYyExMHvP4eXh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzYgZmZiMwAmZgZBQGYWA+wsJhEAYDJiwcBmEYQMLCIzDCAGRkNDMzBmJmZh7j4cfDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA8Pg63gU0msNkRiGACkRiBCOIRiRGIMDKRGIGIARKJG9hMMpvtGMfn4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvB4+Hh4E5jICExMMYiBCMTEMYiB+MTEMYjBmMTEMYhhgMXEMYgxgMXEE5sYiU1MHvP48Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgJmZiMwIiZgZBQCIWA+QkJhEAZiJiwcAiEQQEJCIzCCIGRkNDMzRGZmZh7j4cfDwwM="}],"0.03000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkiSTNmaDbPM2ZuNs8zZmw2zzNmeDbPEqRZIkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA8DoezwSbbbLYIIlkkEkcYwaPROMIIG43GEUbwaDSKIBpFIlEG2SyTyRxxPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwODgcG9hsNjabCEQiEZFIDGKQmFg8hjFubDwewxg2Nh6PYQweG49FIBqLiEQ2sIlsbDaOcTwcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNzsbGJgZiMTExsRAIwYSEhEMwxBkaGg7BEG5oaCgEQiAhIaEYiIfExMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAejsPJIEtkmTzCCBlH4wgjYhyNI4yccTSOMMLG0TjCCBtHowwyRJbJHHEOjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCEQykUgkAhFMJBKNYQwZj8djGHPG4/EYxrDxeDyGMWg8HotABBKJRCIRgUQiEcc4Dg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcHA4JjCRmZhMYhADiYnFYxiDjI3HYxjDjY3HYxiDjY3HYxgDj43HYhADiYnFJjIBmZhMPObx8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA4HA63gU1ms9kRiGAikRiBiCMSiRGIYCKRGIEIJBKJG9hkNpvtCMfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iImExMMYiBicXEMYiBiMXEMYjxiMXEMYiBicXEMYiBicXEE5uImUxMHvP48Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwAmZkZBQGYWDCwsJhEMYjLCwcBmFgwsLCIzACZGRkNDMzYmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4HA63gU1ms9kRiGAikRiBiCMSiRGIYCKRGIEIJBKJG9hkNpvtGMfD4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iImExMMYiBicXEMYjBiMXEMYhhiMXEMYiBicXEMYiBicXEE5uImUxMHvP48Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwImZkZBQCIThCQkJhEAYmLCwcAiFAQkJCIzAiZGRkNDMzZmZmZh7jwcPDwwM="}],"0.03500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkgSTNmSDDPM2bOM88zZkw2zzNmGDbPEqR5JkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA8H4ezwSYLbLYIIlkgEkcYwZ7ROMIIk43GEUYwaDSKIBpBIlEG2SyTyRxxPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwfDgcG9hsBjabCEQiAZFIDGKQj1g8hjHOZjwewxgGNh6PYQwGG49FIBqPiUQ2sIlsbDaOcTwcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNzsDGJgZiMQMxsRAIwXyEhEMwxDEbGg7BEA5oaCgEQiAgIaEYiIeGxMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAensPJIEsEmTzCCHFG4wgjwhuNI4wcaDSOMMLg0TjCCINHowwyBJLJHHGOh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBweByOCEQygkgkAhHMIBKNYQzxjMdjGHNw4/EYxjDYeDyGMQg0HotABAKJRCIRgSAiEcc4DgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODg8HA4JjCREZhMYhADGYjFYxiDeIzHYxjDwYzHYxiDgYzHYxgDg43HYhADgYjFJjIBiZhMPObxePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA4Pg63gU0msNkRiGACkRiBiOMRiRGIYDCRGIEIBBKJG9hkMJvtCMfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iIGExMMYiBGcTEMYiBeMTEMYjxwMTEMYiBgcXEMYiBgcXEE5uIyUxMHvP4eHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgZmZiMwAmZgZBQGYWA+wsJhEMYDJiwcBmFgQMLCIzACBGRkNDMzYmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4Pg63gU0msNkRiGACkRiBiOMRiRGIYDKRGIEIBBKJG9hkMpvtGMfj4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iICExMMYiBCcTEMYjB+MTEMYhhmMTEMYiBgcXEMYiBgcXEE5uIiU1MHvP48Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgJmZiMwIiZgZBQCITg+QkJhEAZmJiwcAiFAQEJCIzAiJGRkNDMzZmZmZh7jwcPDwwM="}],"0.04000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzM43kSJEwiSTNmbjbPM2ZtNs8z5m02zzPmfzbPEiRMIkmePMzjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHAgDoezwYbZbLYIIkwkEkcYUaPROMJIGo3GEUbTaDSKIPpHIlEGGSSTyRxxIA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOAAODgcG9hgNjabCEQ4EZFIDGKcmFg8hjFtbDwew9g2Nh6PYTwbG49FIPqLiEQ2sMFsbDaOcWAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":11,"bits":"AAAAAQAA8AAPhoeHZwM2HBsbmxiIccTExEIgpBESEg7B0GZoaDgEw5mhoaEQCP+EhIRiIIYRExObiRnGzMzMYzwYHh4e"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAQjsPJIGNkmTzCSBlH4wgjZRyNI4yScTSOMEbG0TjC+BtHowwyRJbJHHEQjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBAOByOCEQYkUgkAhFGJBKNYUwZj8djGEPG4/EYxpLxeDyGcWQ8HotA9BeJRCIRQUQiEcc4EA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HOCAcXA4JjCBmZhMYhDDiYnFYxijjY3HYxijjY3HYxiTjY3HYxiLjY3HYhD7i4nFJjKBmZhMPOaB8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnAwHA63gQ1js9kRiCgikRiByCISiRGIJCKRGIHoLxKJG9ggNpvtCAfC4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDA8Hh4E5jgmExMMYjxiMXEMYjRiMXEMYjZiMXEMYjJiMXEMYj9icXEE5vAmExMHvPA8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuABw8PDMwMzOGZmZiMwgmJkZBQGYSTCwsJhEGYiLCwcBmEiwsLCIzDyb2RkNDMzIGZmZh7jAcLDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnAwHA63gQ1js9kRiCgikRiBSCISiRGI/iKRGIEIIhKJG9ggNpvtGIfH4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDA8Hh4E5jgmExMMYjRiMXEMYjRiMXEMYjJiMXEMYj9icXEMYjBiMXEE5vAmExMHvPg8Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuABw8PDMwMzOGZmZiMwwmNkZBQCITRCQkJhECYjLCwcAiH/QkJCIzACY2RkNDMzMGZmZh7jgc/DwwM="}],"0.04500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzM43kSJEwgSTNmTjDPM2bNM88z5k02zzPmHzbPEiRsJkmePMzjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHAgH4ezwYYJbLYIIkwgEkcYUZ7ROMJIko3GEUYTaDSKIPpDIlEGGSSTyRxxIA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOAAfDgcG9hgBjabCEQ4AZFIDGKcj1g8hjHNZjwew9gGNh6PYTwDG49FIPqPiUQ2sMFsbDaOcWAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":11,"bits":"AAAAAQAA8AAPxo+HZwM2HAMbmxiIcQzExEIgpPEREg7B0MZsaDgEwxmgoaEQCP+AhIRiIIYZEhObiRnGzMzMYzwYHh4e"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAQnsPJIGMEmTzCSHFG4wgjxRuNI4wSaDSOMEbg0TjC+INHowwyBJLJHHGQh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBAeByOCEQYgkgkAhHGIBKNYUzxjMdjGENw4/EYxhLYeDyGcQQ0HotA9AeJRCIRQSAiEcc4EAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HOCA8XA4JjCBEZhMYhDDGYjFYxijeYzHYxijwYzHYxiTgYzHYxiLgY3HYhD7g4jFJjKBiZhMPOaBefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnAwPg63gQ0jsNkRiCgCkRiByOIRiRGIJDCRGIHoDxKJG9ggMJvtCAfi4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDA+Hh4E5jgGExMMYjxGMTEMYjReMTEMYjZwMTEMYjJgMXEMYj9gcXEE5vAyExMHvPAeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuAB48fDMwMzOAZmZiMwgmJgZBQGYSQ+wsJhEGYCJiwcBmEiQMLCIzDyD2RkNDMzIGJmZh7jAcLDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnAwPg63gQ0jsNkRiCgCkRiBSOIRiRGI/jKRGIEIAhKJG9ggMpvtGIfn4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDA+Hh4E5jgCExMMYjRCMTEMYjR+MTEMYjJmMTEMYj9gcXEMYjBgMXEE5vAiE1MHvPg8Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuAB48fDMwMzOAJmZiMwwiNgZBQCITQ+QkJhECZjJiwcAiH/QEJCIzACI2RkNDMzMGZmZh7jgc/DwwM="}],"0.05000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEEiSTNmYTbPM2ZvNs8zZnk2zzNmeDbPEqRZIkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHB8DoezwSbYbLYIIkEkEkcYeaPROMJIHo3GEUbgaDSKIAJFIlEGmSyTyRxxPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOD4ODgcG9gMNjabCEQCEZFIDGKfmFg8hrFtbDwewxg8Nh6PYQweG49FIBqLiEQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDz4+Hh2YDNwMbGJgZiAzExsRAIfYSEhEMwNBsaGg7BEGhoaCgEQiAhIaEYiIfExMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHA8jsPJIAtkmTzC6BhH4wijZxyNI4yQcTSOMMLG0TjCCBtHowwyRJbJHHEPjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HODwOByOCEQEkUgkApFBJBKNYewZj8djGOPG4/EYxrDxeDyGMWg8HotABBKJRCIRQUQiEcc4Dg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcXA4JjAhmJhMYhAziInFYxjzjI3HYxiDjY3HYxgDjY3HYxgDj43HYhADiYnFJjIRmZhMPObx8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8HA63gU1gs9kRiAQikRiByCMSiRGIYCKRGIEIJBKJG9hgNpvtCMfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvD48Hh4E5gYmExMMYgZiMXEMYh5iMXEMYjBiMXEMYiBicXEMYiBicXEE5vImExMHvN48Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDhx8PDMwMzBmZmZiMwYmBkZBQGYT7CwsJhEAYmLCwcBmFAwsLCIzACZGRkNDMzYmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnB8HA63gU1gs9kRiAQikRiByCMSiRGIZCKRGIEIJBKJG9hkNpvtGMfD4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvD48Hh4E5gImExMMYgJiMXEMYj5iMXEMYiZiMXEMYiBicXEMYiBicXEE5uImUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDhx8PDMwMzAmZmZiMwImBkZBQCIT5CQkJhEGYmLCwcAiFAQkJCIzAiZGRkNDMzZmZmZh7jwcPDwwM="}],"0.05500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEEgSTNmQTDPM2bPM88zZlk2zzNmGDbPEqR5JkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHB8H4ezwSYIbLYIIkEgEkcYeZ7ROMJIlo3GEUYgaDSKIAJBIlEGmSyTyRxxPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOD4fDgcG9gMBjabCEQCAZFIDGKfj1g8hrHNZjwewxgMNh6PYQwGG49FIBqPiUQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDz8+Ph2YDNwMDGJgZiAwMxsRAIfXyEhEMwNDMbGg7BEAhoaCgEQiAgIaEYiIeGxMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHA8nsPJIAsEmTzC6HBG4wijxxuNI4wQaDSOMMLg0TjCCINHowwyBJLJHHGPh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HODweByOCEQEgkgkApHBIBKNYezxjMdjGONw4/EYxjDYeDyGMQg0HotABAKJRCIRQSAiEcc4DgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODg8XA4JjAhEJhMYhAzGIjFYxjzeIzHYxiDwYzHYxgDgYzHYxgDg43HYhADgYjFJjIRiZhMPObxePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8Pg63gU0gsNkRiAQCkRiByOMRiRGIYDCRGIEIBBKJG9hgMJvtCMfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvD4+Hh4E5gYGExMMYgZGMTEMYh5eMTEMYjBwMTEMYiBgcXEMYiBgcXEE5vIyExMHvN4eHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDh58fDMwMzBgZmZiMwYmBgZBQGYT4+wsJhEAYGJiwcBmFAQMLCIzACBGRkNDMzYmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnB8Pg63gU0gsNkRiAQCkRiByOMRiRGIZDKRGIEIBBKJG9hkMpvtGMfj4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvD4+Hh4E5gICExMMYgJCMTEMYj5+MTEMYiZmMTEMYiBgcXEMYiBgcXEE5uIiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDh58fDMwMzAgJmZiMwIiBgZBQCIT4+QkJhEGZmJiwcAiFAQEJCIzAiJGRkNDMzZmZmZh7jwcPDwwM="}],"0.06000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzO43kSJEkiSTPmYTbPM+ZvNs8z5nk2zzPmeTbPEiRZIkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4DoezwWbbbLYIIkEkEkcYfaPROMLoHo3GEUbjaDSKIBJFIlEGmSyTyRxxOA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HODwODgcG9hsNjabCEQiEZFIDGKBmFg8hvFvbDwew/g0Nh6PYTweG49FIBKLiEQ2sJlsbDaOcXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNzMbGJgZiITExsRAIBYSEhEMw/BkaGg7B8GxoaCgEQiEhIaEYiIXExMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAYjsPJIDNkmTzCaBhH4wijZxyNI4yzcTSOMI7G0TjCOBpHowyyTJbJHHEcjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOCAOByOCEQIkUgkAhFBJBKNYWwYj8djGPvG4/EYxqPxeDyG8Xg8HotAJBaJRCIRiUQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"AAAAAQAAHODAcHA4JjBhmJhMYhAziInFYxjzjY3HYxg7j43HYxgbj43HYxgbj43HYhATi4nFJjIxm5hMPObh8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB4HA63gc1gs9kRiAQikRiByCcSiRGITCKRGIFIJBKJG9hMNpvtCIfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iQmExMMYgZiMXEMYj5iMXEMYiZicXEMYiJicXEMYiJicXEE5uYmUxMHvPw8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuCBw8PDMwMzTGZmZiMwYmBkZBQGYT7CwsJhEGYmLCwcBmHGwsLCIzBibGRkNDMzZmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4HA63gc1ks9kRiAQikRiByCcSiRGITCKRGIFIJBKJG9hMNpvtGIfD4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmUxMMYgJiMXEMYj5iMXEMYiZicXEMYiJicXEMYiJicXEE5uYmUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuCBw8PDMwMzZGZmZiMwYmRkZBQCIT5CQkJhEGYmLCwcAiHGQkJCIzBibGRkNDMzZmZmZh7jwcPDwwM="}],"0.06500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzO43kSJEkgSTPmQTDPM+bPM88z5lk2zzPmGTbPEiR5JkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4H4ezwWYLbLYIIkEgEkcYfZ7ROMLolo3GEUYjaDSKIBJBIlEGmSyTyRxxOA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HODwfDgcG9hsBjabCEQiAZFIDGKBj1g8hvHPZjwew/gENh6PYTwGG49FIBKPiUQ2sJlsbDaOcXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNzMDGJgZiIQMxsRAIBXyEhEMw/DEbGg7B8AxoaCgEQiEgIaEYiIWGxMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAYnsPJIDMEmTzCaHBG4wijxxuNI4wzaDSOMI7g0TjCOIJHowyyDJLJHHGch8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOCAeByOCEQIgkgkAhHBIBKNYWzwjMdjGPtw4/EYxiPYeDyG8Rg0HotAJAaJRCIRiSAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"AAAAAQAAHODA8HA4JjBhEJhMYhAzGIjFYxjzeYzHYxg7w4zHYxgbg4zHYxgbg43HYhATg4jFJjIxi5hMPObhefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB4Pg63gc0gsNkRiAQCkRiByOcRiRGITDCRGIFIBBKJG9hMMJvtCIfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iQGExMMYgZGMTEMYj5eMTEMYiZwcTEMYiJgcXEMYiJgcXEE5uYyUxMHvPweHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuCB48fDMwMzTAZmZiMwYmBgZBQGYT4+wsJhEGYGJiwcBmHGQMLCIzBiDGRkNDMzZmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4Pg63gc0ksNkRiAQCkRiByOcRiRGITDKRGIFIBBKJG9hMMpvtGIfj4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYCUxMMYgJCMTEMYj5+MTEMYiZmcTEMYiJgcXEMYiJgcXEE5uYiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuCB48fDMwMzZAJmZiMwYiRgZBQCIT4+QkJhEGZmJiwcAiHGQEJCIzBiLGRkNDMzZmZmZh7jwcPDwwM="}],"0.07000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"Hrzf43kSJEgiSTNmaDbPM2ZkNs8zZmY2zzNmYjbPEiRCIkmePMPjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHB+DoezwQbabLYIIkgkEkcYYaPROMIIGY3GEUbIaDSKIGJEIlEGGSGTyRxxCA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOD8OTgcG9jANjabCEQgEZFIDGKImFg8hjFmbDwewxgxNh6PYYwYG49FIGKIiEQ2sDFsbDaOcQgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMD74+Hh2YANzMbGJgZiEDExsRAIYYSEhEMwhBgaGg7BEGNoaCgEQgQhIaEYiBnExMRmYmYwMzPzGI+Bh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHA+jsPJIMdkmTzCCBlH4wgjZByNI4yYcTSOMCLG0TjCiBhHowwyQpbJHHEEjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOD4OByOCEQhkUgkAhFIJBKNYQwZj8djGEPG4/EYxpDxeDyGMWY8HotAhBCJRCIRIUQiEcc4DA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODwc3A4JjAZm5hMYhADiYnFYxgDjY3HYxiDjY3HYxiDjI3HYxiDjI3HYhDDiInFJjJBmJhMPOZB8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8HA63gQ1ms9kRiCAikRiBCCISiRGIMCKRGIEIIRKJG9gYNpvtCIfB4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvD48Xh4E5iAmExMMYjBiMXEMYjBiMXEMYhBiMXEMYhhiMXEMYhhiMXEE5sgmExMHvMw8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDhx8PDMwMzYGZmZiMwAmZkZBQGYTDCwsJhEAYjLCwcBmEQwsLCIzCCYWRkNDMzGGZmZh7jwcDDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnB8HA63gU1ks9kRiGAikRiBCCISiRGIICKRGIEIIRKJG9gQNpvtGIfA4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvD48Xh4E5iImUxMMYiBiMXEMYiBiMXEMYhBiMXEMYhBiMXEMYhhiMXEE5sgmExMHvMw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDhx8PDMwMzQmZmZiMwAmZkZBQCISBCQkJhEAYjLCwcAiEQQkJCIzACYWRkNDMzCGZmZh7jgcDDwwM="}],"0.07500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"Hrzf43kSJEggSTNmSDDPM2bEM88zZkY2zzNmAjbPEiRiJkmePMPjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHB+H4ezwQYKbLYIIkggEkcYYZ7ROMIIkY3GEUYIaDSKIGJAIlEGGSGTyRxxCA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOD8fTgcG9jABjabCEQgAZFIDGKIj1g8hjHGZjwewxgBNh6PYYwAG49FIGKMiUQ2sDFsbDaOcQgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMD78+Ph2YANzMDGJgZiEAMxsRAIYXyEhEMwhDAbGg7BEANoaCgEQgQgIaEYiBmGxMRmYmYwMzPzGI+Bh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHA+nsPJIMcEmTzCCHFG4wgjxBuNI4wYaDSOMCLg0TjCiIBHowwyApLJHHGEh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOD4eByOCEQhgkgkAhHIIBKNYQzxjMdjGENw4/EYxhDYeDyGMQY0HotAhACJRCIRISAiEcc4DAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODw83A4JjAZE5hMYhADGYjFYxgDeYzHYxiDwYzHYxiDgIzHYxiDgI3HYhDDgIjFJjJBiJhMPOZBePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8Pg63gQ0msNkRiCACkRiBCOIRiRGIMDCRGIEIARKJG9gYMJvtCIfh4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvD4+Xh4E5iAGExMMYjBGMTEMYjBeMTEMYhBwMTEMYhhgMXEMYhhgMXEE5sgyExMHvMweHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDh58fDMwMzYAZmZiMwAmZgZBQGYTA+wsJhEAYDJiwcBmEQQMLCIzCCAWRkNDMzGGJmZh7jwcDDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnB8Pg63gU0ksNkRiGACkRiBCOIRiRGIIDKRGIEIARKJG9gQMpvtGIfg4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvD4+Xh4E5iICUxMMYiBCMTEMYiB+MTEMYhBmMTEMYhBgMXEMYhhgMXEE5sgiE1MHvMw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDh58fDMwMzQgJmZiMwAiZgZBQCISA+QkJhEAZjJiwcAiEQQEJCIzACIWRkNDMzCGZmZh7jgcDDwwM="}],"0.08000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkiSTNmaTbPM2ZvNs8zZmk2zzPmeTbPEqRZIkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4DoezwSbbbLYIIlkkEkcY2aPROMLIG43GEUbyaDSKIBpHIlEGmSyTyRxxPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwODgcG9hsNjabCEQiEZFIDGKbmFg8hjFvbDwew9g0Nh6PYTweG49FIBqLiEQ2sJlsbDaOcXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNzMbGJgZiMTExsRAIzYSEhEMw5BkaGg7B0GxoaCgEwiEhIaEYiIfExMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAejsPJIMtkmTzCKBlH4wijZxyNI4yccTSOMOrG0TjCKBtHowyyTJbJHHEejsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCEQikUgkApFIJBKNYWwZj8djGHPG4/EYxpzxeDyGsWw8HotAJBKJRCIRiUQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcXA4JjARmZhMYhATiYnFYxizjY3HYxjjjI3HYxjjjY3HYxgTj43HYhATi4nFJjIRm5hMPObh8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8HA63gU1ks9kRiEQikRiBiCMSiRGIbCKRGIFIJBKJG9hkNpvtCMfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmUxMMYiJicXEMYiZiMXEMYjxiMXEMYiZicXEMYiJicXEE5uYmUxMHvPw8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwYmRkZBQGYWbCwsJhEMYjLCwcBmFmwsLCIzAibGRkNDMzZmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4HA63gc1ms9kRiGwikRiBiCMSiRGIbCKRGIFIJBKJG9hsNpvtGMfH4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmUxMMYiZicXEMYiZiMXEMYjxiMXEMYiZicXEMYiJicXEE5uYmUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwYmZkZBQCITxCQkJhEGYmLCwcAiFCQkJCIzAibGRkNDMzZmZmZh7jwcPDwwM="}],"0.08500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSJEkgSTNmSTDPM2bPM88zZkk2zzPmGTbPEqR5JkmePM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4H4ezwSYLbLYIIlkgEkcY2Z7ROMLIk43GEUYyaDSKIBpBIlEGmSyTyRxxPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwfDgcG9hsBjabCEQiAZFIDGKbj1g8hjHPZjwew9gENh6PYTwGG49FIBqPiUQ2sJlsbDaOcXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNzMDGJgZiMQMxsRAIzXyEhEMw5DEbGg7B0AxoaCgEwiEgIaEYiIeGxMRmYjYzMzPzGI+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAensPJIMsEmTzCKHFG4wijxxuNI4wcaDSOMOrg0TjCKINHowyyDJLJHHGeh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBweByOCEQigkgkApHIIBKNYWzxjMdjGHNw4/EYxhzYeDyGsQw0HotAJAKJRCIRiSAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODg8XA4JjAREZhMYhATGYjFYxizeYzHYxjjwIzHYxjjgYzHYxgTg43HYhATg4jFJjIRi5hMPObhefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnB8Pg63gU0ksNkRiEQCkRiBiOMRiRGIbDCRGIFIBBKJG9hkMJvtCMfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYGUxMMYiJGcTEMYiZeMTEMYjxwMTEMYiZgcXEMYiJgcXEE5uYyUxMHvPweHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgZmZiMwYmRgZBQGYWY+wsJhEMYDJiwcBmFmQMLCIzAiDGRkNDMzZmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4Pg63gc0msNkRiGwCkRiBiOMRiRGIbDKRGIFIBBKJG9hsMpvtGMfn4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYCUxMMYiZCcTEMYiZ+MTEMYjxmMTEMYiZgcXEMYiJgcXEE5uYiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgJmZiMwYiZgZBQCITw+QkJhEGZmJiwcAiFCQEJCIzAiLGRkNDMzZmZmZh7jwcPDwwM="}],"0.09000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSpEkiSTPmeTbPM+Z5Ns8zZn82zzNmeDbPEiRJIkmePMfjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA8DoezwSbbbLYIolEkEkcYjaPROMJIHo3GEUb+aDSKIAJFIlEGmSyTyRxxPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwODgcG9hsNjabCERjEZFIDOKxmFg8hrF9bDwew9g/Nh6PYQweG49FIBKJiEQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDNzMbGJgbiMTExsRAIh4SEhEMwNBsaGg7BkG9oaCgEQiAhIaEYiMXExMRmYrYxMzPzGI+Dh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAejsPJIMtkmTzCOBtH4wjjbByNI4yzcTSOMPrG0TjCCBlHowwyRpbJHHEMjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCEQykUgkAtFIJBKNYTwaj8djGI/H4/EYxrbxeDyGMW88HotABBOJRCIRYUQiEcc4DA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"HODgcHA4JjARmZhMYhAbi4nFYxgbj43HYxgbj43HYxgzj43HYxjjj43HYhCDiYnFJjKBmJhMPOZh8PB4AAAQAAAA"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA8HA63gU1ms9kRiEQikRiBSCYSiRGIfCKRGIEIJBKJG9hgNpvtCMfD4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmExMMYiJicXEMYiJicXEMYiZicXEMYjxicXEMYiBicXEE5vImExMHvNw8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwImRkZBQGYULCwsJhEGYuLCwcBmF8wsLCIzACZGRkNDMzYmZmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4HA63gU1ms9kRiEQikRiBSCYSiRGIfCKRGIEIJBKJG9hkNpvtGIfD4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw8Hh4E5iYmExMMYiJicXEMYiJicXEMYiZicXEMYjxicXEMYiBicXEE5vImExMHvNw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMwImRkZBQCIUJCQkJhEGYuLCwcAiF8QkJCIzAiZGRkNDMzZmZmZh7jwcPDwwM="}],"0.09500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSpEkgSTPmWTDPM+bZM88zZl82zzNmGDbPEiRpJkmePMfjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA8H4ezwSYLbLYIolEgEkcYjZ7ROMJIlo3GEUY+aDSKIAJBIlEGmSyTyRxxPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBwfDgcG9hsBjabCERjAZFIDOKxj1g8hrHdZjwew9gPNh6PYQwGG49FIBKNiUQ2sNlsbDaOcTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj8ePh2YDNzMDGJgbiMQMxsRAIh3yEhEMwNDMbGg7BkA9oaCgEQiAgIaEYiMWGxMRmYrYxMzPzGI+Dh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHAensPJIMsEmTzCOHNG4wjjzBuNI4wzaDSOMPrg0TjCCIFHowwyBpLJHHGMh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBweByOCEQygkgkAtHIIBKNYTzyjMdjGI9x4/EYxjbYeDyGMQ80HotABAOJRCIRYSAiEcc4DAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"HODg8HA4JjAREZhMYhAbG4jFYxgbe4zHYxgbw4zHYxgzg4zHYxjjg43HYhCDgYjFJjKBiJhMPOZhePB4AAAQAAAA"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DnA8Pg63gU0msNkRiEQCkRiBSOYRiRGIfDCRGIEIBBKJG9hgMJvtCMfj4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYGExMMYiJGcTEMYiJecTEMYiZwcTEMYjxgcXEMYiBgcXEE5vIyExMHvNweHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgZmZiMwImRgZBQGYUI+wsJhEGYOJiwcBmF8QMLCIzACBGRkNDMzYmJmZh7jwcPDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DnA4Pg63gU0msNkRiEQCkRiBSOYRiRGIfDKRGIEIBBKJG9hkMpvtGIfj4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HvDw+Hh4E5iYCExMMYiJCcTEMYiJ+cTEMYiZmcTEMYjxgcXEMYiBgcXEE5vIiE1MHvNw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDB48fDMwMzZgJmZiMwIiRgZBQCIUI+QkJhEGZuJiwcAiF8QEJCIzAiJGRkNDMzZmZmZh7jwcPDwwM="}],"0.10000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkiSTOYeTbPM5B5Ns8zkHk2zzOQeTbPEhBJIkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4DoezAWHbbLYIDlEkEkdAjKPROAJiHI3GERDjaDSKgBBFIlEGhCyTyRwhOA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwODgcG2BsNjabCDwiEZFIDBixmFg8Bsx4bDweA2Y8Nh6PATMeG49FgBGJiEQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHxsbGJgYeMTExsRBghISEhEOAGRoaGg4BZmhoaCgEGCEhIaEYYMTExMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAcjsPJwMhkmTwCMhpH4wjIaByNIyCjcTSOgIzG0TgCMhpHowyITJbJHDEcjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBwOByOCBgikUgkAoRIJBKNATEej8djQIzH4/EYEOPxeDwGxHg8HosAIRKJRCJBiEQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDgcHA4JsAwmZhMYsAQi4nFY8AYj43HY8AYj43HY8AYj43HY8AYj43HYsAQi4nFJsIwmZhMPObg8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg4HA63AcJms9kRIEQikRgBQiQSiREgRCKRGAFCJBKJGyBsNpvtiI/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E2CYmExMMWCIicXEMWCIicXEMWCIicXEMWCIicXEMWCIicXEE2OYmExMHvvx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDAw8PDMwMIZmZmZiOAYGRkZBQGCMLCwsJhgCAsLCwcBgjCwsLCI4BgZGRkNDMIZmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4HA63gcJms9kRIEQikRgBQiQSiREgRCKRGAFCJBKJGyBsNpvtmI/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw8Hh4E2iYmExMMWCIicXEMWCIicXEMWCIicXEMWCIicXEMWCIicXEE2OYmExMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDAw8PDMwMOZmZmZiPAYGRkZBQCDEJCQkJhwCAsLCwcAgxCQkJCI8BgZGRkNDMMZmZmZh7jw8PDwwM="}],"0.10500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkgSTOYWTDPM5DZM88zkFk2zzOQGTbPEhBpJkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4H4ezAWELbLYIDlEgEkdAjJ7ROAJilI3GERAjaDSKgBBBIlEGhCyTyRwhOA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwfDgcG2BsBjabCDwiAZFIDBixj1g8BszYZjweA2YMNh6PATMGG49FgBGNiUQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHxsDGJgYeMQMxsRBghHyEhEOAGTIbGg4BZghoaCgEGCEgIaEYYMSGxMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAcnsPJwMgEmTwCMnJG4wjIyBuNIyAjaDSOgIzg0TgCMoJHowyIDJLJHDGch8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBweByOCBgigkgkAoTIIBKNATH2jMdjQIxx4/EYEGPYeDwGxBg0HosAIQKJRCJBiCAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDg8HA4JsAwEZhMYsAQG4jFY8AYe4zHY8AYw4zHY8AYg4zHY8AYg43HYsAQg4jFJsIwiZhMPObgefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg4Pg63AcImsNkRIEQCkRgBQuQRiREgRDCRGAFCBBKJGyBsMJvtiI/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw+Hh4E2CYGExMMWCIGcTEMWCIecTEMWCIwcTEMWCIgcXEMWCIgcXEE2OYyExMHvvxeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDA48fDMwMIZgZmZiOAYGRgZBQGCMI+wsJhgCAMJiwcBgjCQMLCI4BgBGRkNDMIZmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4Pg63gcImsNkRIEQCkRgBQuQRiREgRDKRGAFCBBKJGyBsMpvtmI/j4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw+Hh4E2iYCExMMWCICcTEMWCI+cTEMWCImcTEMWCIgcXEMWCIgcXEE2OYiE1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDA48fDMwMOZgJmZiPAYCRgZBQCDEI+QkJhwCBsJiwcAgxCQEJCI8BgJGRkNDMMZmZmZh7jw8PDwwM="}],"0.11000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDE43kSHEciSTMYZjbPMxBkNs8zEGQ2zzMQZDbPEhBEIkmeEMTjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCAQDoezAYHYbLYIDkckEkdAIKPROAICGY3GERDIaDSKgEBEIlEGBCKTyRwhEA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAAAODgcG2AwNjabCDweEZFIDBiMmFg8BgxmbDweAwYzNh6PAYMZG49FgMGIiEQ2wGBsbDaOYTAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PACB4OHh2QCHw8bGJgYeDzExsRBgMISEhEOAwRgaGg4BBmNoaCgEGAwhIaEYYDDExMRmgsEwMzPzGAaDh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAMjsPJwDBkmTwCghhH4wgIYhyNIyCIcTSOgCDG0TgCghhHowwIQpbJHDEMjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEAgOByOCBgMkUgkAgRCJBKNAYEYj8djQCDG4/EYEIjxeDwGBGI8HosAgRCJRCJBIEQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDAcHA4JsDAmJhMYsDAiInFY8DAjI3HY8DAjI3HY8DAjI3HY8DAjI3HYsDAiInFJsLAmJhMPObg8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DjgcHA63AQJhs9kRIBAikRgBAiESiREgECKRGAECIRKJGyAQNpvtiM/H4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnh48Hh4E2BgmExMMWBgiMXEMWBgiMXEMWBgiMXEMWBgiMXEMWBgiMXEE2NgmExMHvv58Xh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDgwcPDMwMIEGZmZiOAAGFkZBQGCBDCwsJhgAAhLCwcBggQwsLCI4AAYWRkNDMIEGZmZh7z48fDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjAYHA63gUJhs9kRIBAikRgBAiESiREgECKRGAECIRKJGyAQNpvtmM/H4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnBw8Hh4E2homExMMWBgiMXEMWBgiMXEMWBgiMXEMWBgiMXEMWBgiMXEE2NgmExMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsCAwcPDMwMOHGZmZiPAgGFkZBQCDBhCQkJhwIAhLCwcAgwYQkJCI8CAYWRkNDMMGGZmZh7jw8fDwwM="}],"0.11500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDE43kSHEcgSTMYRjDPMxDEM88zEEQ2zzMQBDbPEhBkJkmeEMTjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCAQH4ezAYEIbLYIDkcgEkdAIJ7ROAICkY3GERAIaDSKgEBAIlEGBCKTyRwhEA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAAAfDgcG2AwBjabCDweAZFIDBiMj1g8BgzGZjweAwYDNh6PAYMBG49FgMGMiUQ2wGBsbDaOYTAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PACB8OPh2QCHw8DGJgYeDwMxsRBgMHyEhEOAwTAbGg4BBgNoaCgEGAwgIaEYYDCGxMRmgsEwMzPzGAaDh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAMnsPJwDAEmTwCgnBG4wgIwhuNIyAIaDSOgCDg0TgCgoBHowwIApLJHDGMh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEAgeByOCBgMgkgkAgTCIBKNAYHwjMdjQCBw4/EYEAjYeDwGBAI0HosAgQCJRCJBICAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDA8HA4JsDAEJhMYsDAGIjFY8DAeIzHY8DAwIzHY8DAgIzHY8DAgI3HYsDAgIjFJsLAiJhMPObgePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DjgcPg63AQIhsNkRIBACkRgBAuERiREgEDCRGAECARKJGyAQMJvtiM/n4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnh4+Hh4E2BgGExMMWBgGMTEMWBgeMTEMWBgwMTEMWBggMXEMWBggMXEE2NgyExMHvv5eXh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDg4cfDMwMIEAZmZiOAAGFgZBQGCBA+wsJhgAABJiwcBggQQMLCI4AAAWRkNDMIEGJmZh7z48fDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjAYPg63gUIhsNkRIBACkRgBAuERiREgEDKRGAECARKJGyAQMpvtmM/n4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnBw+Hh4E2hoCExMMWBgCMTEMWBg+MTEMWBgmMTEMWBggMXEMWBggMXEE2NgiE1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsCA4cfDMwMOHAJmZiPAgCFgZBQCDBg+QkJhwIBhJiwcAgwYQEJCI8CAIWRkNDMMGGZmZh7jw8fDwwM="}],"0.12000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHFkiSTOYeTbPMxBoNs8zEGY2zzMQYzbPEpBBIkmekN/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4DoezASHbbLYIjlEkEkdAgKPROAICGo3GERDMaDSKgDBEIlEGxCCTyRwhfg6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HADwODgcG2BMNjabCDxiEZFIDBixmFg8BgxsbDweAwYzNh6PAcMYG49FgDGIiEQ2wAxsbDaOYf4cHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHzMbGJgYeITExsRBghISEhEOAARsaGg4BBmdoaCgEGAYhIaEYYAzExMRmghEwMzPzGOaPh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAejsPJwEhkmTwCAhtH4wgIZByNIyCQcTSOgCDG0TgCQhhHowwIQJbJHDE+jsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBwOByOCBgykUgkAkRMJBKNAQEbj8djQMDG4/EYEJDxeDwGBGI8HosAQRCJRCJBCEUiEcc4Pg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDgcHA4JsCQmZhMYsAIiYnFY8AAjY3HY8AAjY3HY8CAjI3HY8BAjI3HYsAgiInFJsIgmphMPObw8/B4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg8HA63AUJms9kRIEAikRgBAiYSiREgMCKRGAGCIRKJGyAMNpvtiM/H4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnh48Hh4E2DImExMMWCAicXEMWCAiMXEMWDAiMXEMWBgiMXEMWAwiMXEE2MYmExMHvv58Xh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDAw8PDMwMIYmZmZiOAAGZkZBQGCGDCwsJhgAAjLCwcBggYwsLCI4DAYGRkNDMIBmZmZh7z48fDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA8HA63gUJms9kRIGAikRgBAiISiREgMCKRGAGCIRKJGyBMNpvtmM/H4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnB48Hh4E2jImExMMWCAiMXEMWCAiMXEMWDAiMXEMWBgiMXEMWAwiMXEE2MYmUxMHvP48Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDAw8PDMwMOZmZmZiPAIGZkZBQCDGBCQkJhwAAiLCwcAgwQQkJCI8CAYGRkNDMMRGZmZh7j48fDwwM="}],"0.12500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHFkgSTOYWTDPMxDIM88zEEY2zzMQAzbPEpBhJkmekN/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4H4ezASELbLYIjlEgEkdAgJ7ROAICko3GERAMaDSKgDBAIlEGxCCTyRwhfg+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HADwfDgcG2BMBjabCDxiAZFIDBixj1g8BgzMZjweAwYDNh6PAcMAG49FgDGMiUQ2wAxsbDaOYf4cHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHzMDGJgYeIQMxsRBghHyEhEOAATMbGg4BBgdoaCgEGAYgIaEYYAyGxMRmghEwMzPzGOaPh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAensPJwEgEmTwCAnNG4wgIxBuNIyAQaDSOgCDg0TgCQoBHowwIAJLJHDG+h8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBweByOCBgygkgkAkTMIBKNAQHzjMdjQMBw4/EYEBDYeDwGBAI0HosAQQCJRCJBCCEiEcc4PgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDg8HA4JsCQEZhMYsAIGYjFY8AAeYzHY8AAwYzHY8CAgIzHY8BAgI3HYsAggIjFJsIgiphMPObwe/B4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg8Pg63AUImsNkRIEACkRgBAuYRiREgMDCRGAGCARKJGyAMMJvtiM/n4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnh4+Hh4E2DIGExMMWCAGcTEMWCAeMTEMWDAwMTEMWBggMXEMWAwgMXEE2MYyExMHvv5eXh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDA48fDMwMIYgZmZiOAAGZgZBQGCGA+wsJhgAADJiwcBggYQMLCI4DAAGRkNDMIBmJmZh7z48fDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA8Pg63gUImsNkRIGACkRgBAuIRiREgMDKRGAGCARKJGyBMMpvtmM/n4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnB4+Hh4E2jICExMMWCACMTEMWCA+MTEMWDAmMTEMWBggMXEMWAwgMXEE2MYiU1MHvP48Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDA48fDMwMOZgJmZiPAICZgZBQCDGA+QkJhwABiJiwcAgwQQEJCI8CAIGRkNDMMRGZmZh7j48fDwwM="}],"0.13000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkiSTMYaDbPMxBuNs8zEGw2zzMQeDbPEpBZIkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA8DoezASHbbLYIDlkkEkdAwKPROAICG43GERDwaDSKgBhFIlEGxCyTyRwhPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwODgcG2BsNjabCDwiEZFIDBiQmFg8BgxubDweAwY2Nh6PAQMeG49FgBmLiEQ2wIhsbDaOYTwcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHzsbGJgYeMTExsRBgwISEhEOAwRkaGg4BBm5oaCgEGCAhIaEYYIbExMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAejsPJwEhkmTwCAhlH4wgIYhyNIyCccTSOgMDG0TgCAhtHowwIRJbJHDEOjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBwOByOCBgykUgkAgRMJBKNAQEZj8djQHDG4/EYELDxeDwGBGg8HosAARKJRCJBgEQiEcc4Dg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDgcHA4JsCQmZhMYsAAiYnFY8CAjI3HY8DAjY3HY8CAjY3HY8AAj43HYsAAiYnFJsIAmZhMPObw8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg4HA63AUJms9kRIGAikRgBgiMSiREgYCKRGAECJBKJGyBkNpvtiM/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E2CImExMMWCAicXEMWCAiMXEMWDwiMXEMWCAicXEMWCAicXEE2OImUxMHvv58Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDAw8PDMwMIZmZmZiOAAGZkZBQGCGDCwsJhgMAjLCwcBghgwsLCI4AAZGRkNDMIYmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4HA63gUJms9kRIGAikRgBgiMSiREgYCKRGAECJBKJGyBkNpvtmM/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw8Hh4E2iImExMMWCAicXEMWDAiMXEMWBgiMXEMWCAicXEMWCAicXEE2OImUxMHvP48Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDAw8PDMwMOZmZmZiPAIGZkZBQCDDhCQkJhwAAmLCwcAgxAQkJCI8AgZGRkNDMMZmZmZh7jw8PDwwM="}],"0.13500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkgSTMYSDDPMxDOM88zEEw2zzMQGDbPEpB5JkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA8H4ezASELbLYIDlkgEkdAwJ7ROAICk43GERAwaDSKgBhBIlEGxCyTyRwhPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwfDgcG2BsBjabCDwiAZFIDBiQj1g8BgzOZjweAwYGNh6PAQMGG49FgBmPiUQ2wIhsbDaOYTwcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHzsDGJgYeMQMxsRBgwHyEhEOAwTEbGg4BBg5oaCgEGCAgIaEYYIaGxMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAensPJwEgEmTwCAnFG4wgIwhuNIyAcaDSOgMDg0TgCAoNHowwIBJLJHDGOh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBweByOCBgygkgkAgTMIBKNAQHxjMdjQHBw4/EYEDDYeDwGBAg0HosAAQKJRCJBgCAiEcc4DgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDg8HA4JsCQEZhMYsAAGYjFY8CAeIzHY8DAwYzHY8CAgYzHY8AAg43HYsAAgYjFJsIAiZhMPObwePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg4Pg63AUImsNkRIGACkRgBguMRiREgYDCRGAECBBKJGyBkMJvtiM/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw+Hh4E2CIGExMMWCAGcTEMWCAeMTEMWDwwMTEMWCAgcXEMWCAgcXEE2OIyUxMHvv5eHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDA48fDMwMIZgZmZiOAAGZgZBQGCGA+wsJhgMADJiwcBghgQMLCI4AABGRkNDMIYmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4Pg63gUImsNkRIGACkRgBguMRiREgYDKRGAECBBKJGyBkMpvtmM/j4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw+Hh4E2iICExMMWCACcTEMWDA+MTEMWBgmMTEMWCAgcXEMWCAgcXEE2OIiU1MHvP48Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDA48fDMwMOZgJmZiPAICZgZBQCDDg+QkJhwABmJiwcAgxAQEJCI8AgJGRkNDMMZmZmZh7jw8PDwwM="}],"0.14000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDM43kSHEwiSTMYbjbPMxBtNs8zkG02zzOQfzbPEhBMIkmeEMzjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCAgDoezAYHZbLYIDkwkEkdAUKPROAJCGo3GERDTaDSKgPhHIlEGBCSTyRwhIA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAAAODgcG2BgNjabCDw4EZFIDBicmFg8BgxtbDweA8Y2Nh6PATMbG49FgPmLiEQ2wMBsbDaOYWAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":11,"bits":"AAAAAQAA8AAEhoeHZwMcHBsbmxh4cMTExEKAoRESEg4BxmZoaDgEmJmhoaEQYP6EhIRigIERExObCQbGzMzMYxgYHh4e"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAQjsPJwGBkmTwCQhlH4wgIZRyNIyCScTSOgETG0TgC8htHowwIRJbJHDEQjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBAOByOCBgYkUgkAgRGJBKNAUEZj8djQEDG4/EYEJLxeDwGRGQ8HosA8ReJRCJBQEQiEcc4EA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMCAcXA4JsCAmZhMYsDAiYnFY8CgjY3HY8CgjY3HY8CQjY3HY8CIjY3HYsD4i4nFJsKAmZhMPOaA8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DjgwHA63AQJjs9kRICgikRgBwiISiREgJCKRGAHiLxKJGyAgNpvtiA/C4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HnjA8Hh4E2DgmExMMWDwiMXEMWDQiMXEMWDYiMXEMWDIiMXEMWD8icXEE2PAmExMHvvB8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvAAw8PDMwMIOGZmZiOAgGJkZBQGCCTCwsJhgGAiLCwcBggiwsLCI4Dwb2RkNDMIIGZmZh7zA8LDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjAwHA63gQJjs9kRICgikRgBQiISiREg/iKRGAECIhKJGyAgNpvtmI/H4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDA8Hh4E2jgmExMMWDQiMXEMWDQiMXEMWDIiMXEMWD8icXEMWDAiMXEE2PAmExMHvPg8Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsAAw8PDMwMOOGZmZiPAwGNkZBQCDDRCQkJhwCAjLCwcAgz/QkJCI8AAY2RkNDMMMGZmZh7jg8/DwwM="}],"0.14500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDM43kSHEwgSTMYTjDPMxDNM88zkE02zzOQHzbPEhBsJkmeEMzjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCAgH4ezAYEJbLYIDkwgEkdAUJ7ROAJCko3GERATaDSKgPhDIlEGBCSTyRwhIA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAAAfDgcG2BgBjabCDw4AZFIDBicj1g8BgzNZjweA8YGNh6PATMDG49FgPmPiUQ2wMBsbDaOYWAcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":11,"bits":"AAAAAQAA8AAExo+HZwMcHAMbmxh4cAzExEKAofEREg4BxsZsaDgEmBmgoaEQYP6AhIRigIEZEhObCQbGzMzMYxgYHh4e"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAQnsPJwGAEmTwCQnFG4wgIxRuNIyASaDSOgETg0TgC8oNHowwIBJLJHDGQh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBAeByOCBgYgkgkAgTGIBKNAUHxjMdjQEBw4/EYEBLYeDwGRAQ0HosA8QeJRCJBQCAiEcc4EAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMCA8XA4JsCAEZhMYsDAGYjFY8CgeYzHY8CgwYzHY8CQgYzHY8CIgY3HYsD4g4jFJsKAiZhMPOaAefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"DjgwPg63AQIjsNkRICgCkRgBwuIRiREgJDCRGAHiDxKJGyAgMJvtiA/i4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"HnjA+Hh4E2DgGExMMWDwGMTEMWDQeMTEMWDYwMTEMWDIgMXEMWD8gcXEE2PAyExMHvvBeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvAA48fDMwMIOAZmZiOAgGJgZBQGCCQ+wsJhgGACJiwcBggiQMLCI4DwD2RkNDMIIGJmZh7zA8LDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjAwPg63gQIjsNkRICgCkRgBQuIRiREg/jKRGAECAhKJGyAgMpvtmI/n4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDA+Hh4E2jgCExMMWDQCMTEMWDQ+MTEMWDImMTEMWD8gcXEMWDAgMXEE2PAiE1MHvPg8Xh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsAA48fDMwMOOAJmZiPAwCNgZBQCDDQ+QkJhwCBjJiwcAgz/QEJCI8AAI2RkNDMMMGZmZh7jg8/DwwM="}],"0.15000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEEiSTMYYTbPMxBvNs8zEHk2zzMQeDbPEpBZIkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCB8DoezASHYbLYIDkEkEkdAeKPROAJCHo3GERDgaDSKgABFIlEGhCyTyRwhPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAD4ODgcG2AMNjabCDwCEZFIDBifmFg8BoxtbDweAwY8Nh6PAQMeG49FgBmLiEQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADx4+Hh2QDHwMbGJgYeAzExsRBgfISEhEOAMRsaGg4BBmhoaCgEGCAhIaEYYIbExMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDA8jsPJwAhkmTwC4hhH4wiIZxyNIyCQcTSOgMDG0TgCAhtHowwIRJbJHDEPjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEDwOByOCBgEkUgkAoRBJBKNAeEZj8djQODG4/EYELDxeDwGBGg8HosAARKJRCJBQEQiEcc4Dg6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDgcXA4JsAgmJhMYsAwiInFY8DwjI3HY8CAjY3HY8AAjY3HY8AAj43HYsAAiYnFJsIQmZhMPObw8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8HA63AUJgs9kRIAQikRgBwiMSiREgYCKRGAECJBKJGyBgNpvtiM/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnj48Hh4E2AYmExMMWAYiMXEMWB4iMXEMWDAiMXEMWCAicXEMWCAicXEE2PImExMHvt58Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDgx8PDMwMIBmZmZiOAYGBkZBQGCD7CwsJhgAAmLCwcBghAwsLCI4AAZGRkNDMIYmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjB8HA63gUJgs9kRIAQikRgBwiMSiREgZCKRGAECJBKJGyBkNpvtmM/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnD48Hh4E2gImExMMWAIiMXEMWD4iMXEMWCYiMXEMWCAicXEMWCAicXEE2OImUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDgx8PDMwMOAmZmZiPAIGBkZBQCDD5CQkJhwGAmLCwcAgxAQkJCI8AgZGRkNDMMZmZmZh7jw8PDwwM="}],"0.15500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEEgSTMYQTDPMxDPM88zEFk2zzMQGDbPEpB5JkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCB8H4ezASEIbLYIDkEgEkdAeJ7ROAJClo3GERAgaDSKgABBIlEGhCyTyRwhPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAD4fDgcG2AMBjabCDwCAZFIDBifj1g8BozNZjweAwYMNh6PAQMGG49FgBmPiUQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADx8+Ph2QDHwMDGJgYeAwMxsRBgfHyEhEOAMTMbGg4BBghoaCgEGCAgIaEYYIaGxMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDA8nsPJwAgEmTwC4nBG4wiIxxuNIyAQaDSOgMDg0TgCAoNHowwIBJLJHDGPh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEDweByOCBgEgkgkAoTBIBKNAeHxjMdjQOBw4/EYEDDYeDwGBAg0HosAAQKJRCJBQCAiEcc4DgeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDg8XA4JsAgEJhMYsAwGIjFY8DweIzHY8CAwYzHY8AAgYzHY8AAg43HYsAAgYjFJsIQiZhMPObwePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8Pg63AUIgsNkRIAQCkRgBwuMRiREgYDCRGAECBBKJGyBgMJvtiM/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnj4+Hh4E2AYGExMMWAYGMTEMWB4eMTEMWDAwMTEMWCAgcXEMWCAgcXEE2PIyExMHvt5eHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDg58fDMwMIBgZmZiOAYGBgZBQGCD4+wsJhgAAGJiwcBghAQMLCI4AABGRkNDMIYmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjB8Pg63gUIgsNkRIAQCkRgBwuMRiREgZDKRGAECBBKJGyBkMpvtmM/j4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnD4+Hh4E2gICExMMWAICMTEMWD4+MTEMWCYmMTEMWCAgcXEMWCAgcXEE2OIiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDg58fDMwMOAgJmZiPAICBgZBQCDD4+QkJhwGBmJiwcAgxAQEJCI8AgJGRkNDMMZmZmZh7jw8PDwwM="}],"0.16000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDO43kSHEkiSTOYYTbPM5BvNs8zkHk2zzOQeTbPEhBZIkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4DoezAWHbbLYIDkEkEkdAfKPROALiHo3GERDjaDSKgBBFIlEGhCyTyRwhOA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HADwODgcG2BsNjabCDwiEZFIDBiBmFg8BsxvbDweA+Y0Nh6PATMeG49FgBGLiEQ2wJhsbDaOYXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHzMbGJgYeITExsRBgBISEhEOA+RkaGg4B5mxoaCgEGCEhIaEYYITExMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAYjsPJwDBkmTwCYhhH4wiIZxyNIyCzcTSOgIzG0TgCMhpHowyITJbJHDEcjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HECAOByOCBgIkUgkAgRBJBKNAWEYj8djQPjG4/EYEKPxeDwGxHg8HosAIRaJRCJBiEQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"AAAAAQAAHMDAcHA4JsBgmJhMYsAwiInFY8DwjY3HY8A4j43HY8AYj43HY8AYj43HYsAQi4nFJsIwm5hMPObg8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh4HA63AcJgs9kRIAQikRgBwicSiREgTCKRGAFCJBKJGyBMNpvtiI/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E2CQmExMMWAYiMXEMWD4iMXEMWCYicXEMWCIicXEMWCIicXEE2OYmUxMHvvx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvCAw8PDMwMITGZmZiOAYGBkZBQGCD7CwsJhgGAmLCwcBgjGwsLCI4BgbGRkNDMIZmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4HA63gcJks9kRIAQikRgBwicSiREgTCKRGAFCJBKJGyBMNpvtmI/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw8Hh4E2iYmUxMMWAIiMXEMWD4iMXEMWCYicXEMWCIicXEMWCIicXEE2OYmUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsCAw8PDMwMOZGZmZiPAYGRkZBQCDD5CQkJhwGAmLCwcAgzGQkJCI8BgbGRkNDMMZmZmZh7jw8PDwwM="}],"0.16500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDO43kSHEkgSTOYQTDPM5DPM88zkFk2zzOQGTbPEhB5JkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4H4ezAWELbLYIDkEgEkdAfJ7ROALilo3GERAjaDSKgBBBIlEGhCyTyRwhOA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HADwfDgcG2BsBjabCDwiAZFIDBiBj1g8BszPZjweA+YENh6PATMGG49FgBGPiUQ2wJhsbDaOYXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHzMDGJgYeIQMxsRBgBHyEhEOA+TEbGg4B5gxoaCgEGCEgIaEYYISGxMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAYnsPJwDAEmTwCYnBG4wiIxxuNIyAzaDSOgIzg0TgCMoJHowyIDJLJHDGch8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HECAeByOCBgIgkgkAgTBIBKNAWHwjMdjQPhw4/EYECPYeDwGxBg0HosAIQaJRCJBiCAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"AAAAAQAAHMDA8HA4JsBgEJhMYsAwGIjFY8DweYzHY8A4w4zHY8AYg4zHY8AYg43HYsAQg4jFJsIwi5hMPObgefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh4Pg63AcIgsNkRIAQCkRgBwucRiREgTDCRGAFCBBKJGyBMMJvtiI/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw+Hh4E2CQGExMMWAYGMTEMWD4eMTEMWCYwcTEMWCIgcXEMWCIgcXEE2OYyUxMHvvxeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvCA48fDMwMITAZmZiOAYGBgZBQGCD4+wsJhgGAGJiwcBgjGQMLCI4BgDGRkNDMIZmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4Pg63gcIksNkRIAQCkRgBwucRiREgTDKRGAFCBBKJGyBMMpvtmI/j4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw+Hh4E2iYCUxMMWAICMTEMWD4+MTEMWCYmcTEMWCIgcXEMWCIgcXEE2OYiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsCA48fDMwMOZAJmZiPAYCRgZBQCDD4+QkJhwGBmJiwcAgzGQEJCI8BgLGRkNDMMZmZmZh7jw8PDwwM="}],"0.17000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HpDf43kSHEgiSTMYaDbPMxBkNs8zEGY2zzMQYjbPEhBCIkmeEMPjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCB+DoezAQHabLYIDkgkEkdAYKPROAICGY3GERDIaDSKgGBEIlEGBCGTyRwhCA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAD8OTgcG2DANjabCDwgEZFIDBiImFg8BgxmbDweAwYxNh6PAYMYG49FgGGIiEQ2wDBsbDaOYQgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PAD54+Hh2QAHzMbGJgYeEDExsRBgYISEhEOAgRgaGg4BBmNoaCgEGAQhIaEYYBjExMRmgmEwMzPzGIaBh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDA+jsPJwMRkmTwCAhlH4wgIZByNIyCYcTSOgCDG0TgCghhHowwIQpbJHDEEjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HED4OByOCBghkUgkAgRIJBKNAQEZj8djQEDG4/EYEJDxeDwGBGY8HosAgRCJRCJBIEQiEcc4DA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDwc3A4JsAYm5hMYsAAiYnFY8AAjY3HY8CAjY3HY8CAjI3HY8CAjI3HYsDAiInFJsJAmJhMPOZA8PB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8HA63AQJms9kRICAikRgBAiISiREgMCKRGAECIRKJGyAYNpvtiI/B4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnj48Xh4E2CAmExMMWDAiMXEMWDAiMXEMWBAiMXEMWBgiMXEMWBgiMXEE2MgmExMHvsx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDgx8PDMwMIYGZmZiOAAGZkZBQGCDDCwsJhgAAjLCwcBggQwsLCI4CAYWRkNDMIGGZmZh7zw8DDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjB8HA63gUJks9kRIGAikRgBAiISiREgICKRGAECIRKJGyAQNpvtmI/A4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnD48Xh4E2iImUxMMWCAiMXEMWCAiMXEMWBAiMXEMWBAiMXEMWBgiMXEE2MgmExMHvMw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDgx8PDMwMOQmZmZiPAAGZkZBQCDCBCQkJhwAAjLCwcAgwQQkJCI8AAYWRkNDMMCGZmZh7jg8DDwwM="}],"0.17500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HpDf43kSHEggSTMYSDDPMxDEM88zEEY2zzMQAjbPEhBiJkmeEMPjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCB+H4ezAQEKbLYIDkggEkdAYJ7ROAICkY3GERAIaDSKgGBAIlEGBCGTyRwhCA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HAD8fTgcG2DABjabCDwgAZFIDBiIj1g8BgzGZjweAwYBNh6PAYMAG49FgGGMiUQ2wDBsbDaOYQgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PAD58+Ph2QAHzMDGJgYeEAMxsRBgYHyEhEOAgTAbGg4BBgNoaCgEGAQgIaEYYBiGxMRmgmEwMzPzGIaBh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDA+nsPJwMQEmTwCAnFG4wgIxBuNIyAYaDSOgCDg0TgCgoBHowwIApLJHDGEh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HED4eByOCBghgkgkAgTIIBKNAQHxjMdjQEBw4/EYEBDYeDwGBAY0HosAgQCJRCJBICAiEcc4DAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDw83A4JsAYE5hMYsAAGYjFY8AAeYzHY8CAwYzHY8CAgIzHY8CAgI3HYsDAgIjFJsJAiJhMPOZAePB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8Pg63AQImsNkRICACkRgBAuIRiREgMDCRGAECARKJGyAYMJvtiI/h4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnj4+Xh4E2CAGExMMWDAGMTEMWDAeMTEMWBAwMTEMWBggMXEMWBggMXEE2MgyExMHvsxeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDg58fDMwMIYAZmZiOAAGZgZBQGCDA+wsJhgAADJiwcBggQQMLCI4CAAWRkNDMIGGJmZh7zw8DDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjB8Pg63gUIksNkRIGACkRgBAuIRiREgIDKRGAECARKJGyAQMpvtmI/g4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnD4+Xh4E2iICUxMMWCACMTEMWCA+MTEMWBAmMTEMWBAgMXEMWBggMXEE2MgiE1MHvMw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDg58fDMwMOQgJmZiPAACZgZBQCDCA+QkJhwABjJiwcAgwQQEJCI8AAIWRkNDMMCGZmZh7jg8DDwwM="}],"0.18000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkiSTMYaTbPMxBvNs8zEGk2zzOQeTbPEpBZIkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4DoezASHbbLYIDlkkEkdA2KPROALCG43GERDyaDSKgBhHIlEGhCyTyRwhPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwODgcG2BsNjabCDwiEZFIDBibmFg8BgxvbDweA8Y0Nh6PATMeG49FgBmLiEQ2wJhsbDaOYXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHzMbGJgYeMTExsRBgzISEhEOA4RkaGg4BxmxoaCgEmCEhIaEYYIbExMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAejsPJwMhkmTwCIhlH4wiIZxyNIyCccTSOgOjG0TgCIhtHowyITJbJHDEejsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBwOByOCBgikUgkAoRIJBKNAWEZj8djQHDG4/EYEJzxeDwGhGw8HosAIRKJRCJBiEQiEcc4HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDgcXA4JsAQmZhMYsAQiYnFY8CwjY3HY8DgjI3HY8DgjY3HY8AQj43HYsAQi4nFJsIQm5hMPObg8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8HA63AUJks9kRIEQikRgBgiMSiREgbCKRGAFCJBKJGyBkNpvtiM/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E2CYmUxMMWCIicXEMWCYiMXEMWDwiMXEMWCYicXEMWCIicXEE2OYmUxMHvvx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDAw8PDMwMIZmZmZiOAYGRkZBQGCGbCwsJhgMAjLCwcBghmwsLCI4AgbGRkNDMIZmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4HA63gcJms9kRIGwikRgBgiMSiREgbCKRGAFCJBKJGyBsNpvtmM/H4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw8Hh4E2iYmUxMMWCYicXEMWCYiMXEMWDwiMXEMWCYicXEMWCIicXEE2OYmUxMHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDAw8PDMwMOZmZmZiPAYGZkZBQCDDxCQkJhwGAmLCwcAgxCQkJCI8AgbGRkNDMMZmZmZh7jw8PDwwM="}],"0.18500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSHEkgSTMYSTDPMxDPM88zEEk2zzOQGTbPEpB5JkmeEM/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA4H4ezASELbLYIDlkgEkdA2J7ROALCk43GERAyaDSKgBhBIlEGhCyTyRwhPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwfDgcG2BsBjabCDwiAZFIDBibj1g8BgzPZjweA8YENh6PATMGG49FgBmPiUQ2wJhsbDaOYXgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHzMDGJgYeMQMxsRBgzHyEhEOA4TEbGg4BxgxoaCgEmCEgIaEYYIaGxMRmgjEzMzPzGIaHh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAensPJwMgEmTwCInFG4wiIxxuNIyAcaDSOgOjg0TgCIoNHowyIDJLJHDGeh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBweByOCBgigkgkAoTIIBKNAWHxjMdjQHBw4/EYEBzYeDwGhAw0HosAIQKJRCJBiCAiEcc4HAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HMDg8XA4JsAQEZhMYsAQGYjFY8CweYzHY8DgwIzHY8DggYzHY8AQg43HYsAQg4jFJsIQi5hMPObgefB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djh8Pg63AUIksNkRIEQCkRgBguMRiREgbDCRGAFCBBKJGyBkMJvtiM/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw+Hh4E2CYGUxMMWCIGcTEMWCYeMTEMWDwwMTEMWCYgcXEMWCIgcXEE2OYyUxMHvvxeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDA48fDMwMIZgZmZiOAYGRgZBQGCGY+wsJhgMADJiwcBghmQMLCI4AgDGRkNDMIZmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4Pg63gcImsNkRIGwCkRgBguMRiREgbDKRGAFCBBKJGyBsMpvtmM/n4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw+Hh4E2iYCUxMMWCYCcTEMWCY+MTEMWDwmMTEMWCYgcXEMWCIgcXEE2OYiU1MHvPw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDA48fDMwMOZgJmZiPAYCZgZBQCDDw+QkJhwGBmJiwcAgxCQEJCI8AgLGRkNDMMZmZmZh7jw8PDwwM="}],"0.19000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSnEkiSTOYeTbPM5B5Ns8zEH82zzMQeDbPEhBJIkmeEMfjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA8DoezASHbbLYIjlEkEkdAjKPROAJCHo3GERD+aDSKgABFIlEGhCyTyRwhPA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwODgcG2BsNjabCDxjEZFIDJixmFg8Box9bDweA8Y/Nh6PAQMeG49FgBGJiEQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh4eHh2QDHzMbGJgaeMTExsRBghoSEhEOAMRsaGg4Bhm9oaCgEGCAhIaEYYMTExMRmgrExMzPzGIaDh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAejsPJwMhkmTwCMhtH4wjIbByNIyCzcTSOgPjG0TgCAhlHowwIRpbJHDEMjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBwOByOCBgykUgkAsRIJBKNATEaj8djQIzH4/EYELbxeDwGBG88HosAAROJRCJBYEQiEcc4DA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"HMDgcHA4JsAQmZhMYsAYi4nFY8AYj43HY8AYj43HY8Awj43HY8Dgj43HYsCAiYnFJsKAmJhMPOZg8PB4AAAQAAAA"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg8HA63AUJms9kRIEQikRgBQiYSiREgfCKRGAECJBKJGyBgNpvtiM/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E2CYmExMMWCIicXEMWCIicXEMWCYicXEMWDwicXEMWCAicXEE2PImExMHvtx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDAw8PDMwMIZmZmZiOAIGRkZBQGCELCwsJhgGAuLCwcBgh8wsLCI4AAZGRkNDMIYmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4HA63gUJms9kRIEQikRgBQiYSiREgfCKRGAECJBKJGyBkNpvtmI/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw8Hh4E2iYmExMMWCIicXEMWCIicXEMWCYicXEMWDwicXEMWCAicXEE2PImExMHvNw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDAw8PDMwMOZmZmZiPAIGRkZBQCDEJCQkJhwGAuLCwcAgx8QkJCI8AgZGRkNDMMZmZmZh7jw8PDwwM="}],"0.19500":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HhDP43kSnEkgSTOYWTDPM5DZM88zEF82zzMQGDbPEhBpJkmeEMfjeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HCA8H4ezASELbLYIjlEgEkdAjJ7ROAJClo3GERA+aDSKgABBIlEGhCyTyRwhPA+HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HABwfDgcG2BsBjabCDxjAZFIDJixj1g8BozdZjweA8YPNh6PAQMGG49FgBGNiUQ2wNhsbDaOYTgcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PADh8ePh2QDHzMDGJgaeMQMxsRBghnyEhEOAMTMbGg4Bhg9oaCgEGCAgIaEYYMSGxMRmgrExMzPzGIaDh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HDAensPJwMgEmTwCMnNG4wjIzBuNIyAzaDSOgPjg0TgCAoFHowwIBpLJHDGMh8MB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HEBweByOCBgygkgkAsTIIBKNATHyjMdjQIxx4/EYEDbYeDwGBA80HosAAQOJRCJBYCAiEcc4DAeHAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":11,"bits":"HMDg8HA4JsAQEZhMYsAYG4jFY8AYe4zHY8AYw4zHY8Awg4zHY8Dgg43HYsCAgYjFJsKAiJhMPOZgePB4AAAQAAAA"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Djg8Pg63AUImsNkRIEQCkRgBQuYRiREgfDCRGAECBBKJGyBgMJvtiM/j4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw+Hh4E2CYGExMMWCIGcTEMWCIecTEMWCYwcTEMWDwgcXEMWCAgcXEE2PIyExMHvtxeHh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HvDA48fDMwMIZgZmZiOAIGRgZBQGCEI+wsJhgGAOJiwcBgh8QMLCI4AABGRkNDMIYmJmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"DjA4Pg63gUImsNkRIEQCkRgBQuYRiREgfDKRGAECBBKJGyBkMpvtmI/j4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"HnDw+Hh4E2iYCExMMWCICcTEMWCI+cTEMWCYmcTEMWDwgcXEMWCAgcXEE2PIiE1MHvNw8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HsDA48fDMwMOZgJmZiPAICRgZBQCDEI+QkJhwGBuJiwcAgx8QEJCI8AgJGRkNDMMZmZmZh7jw8PDwwM="}],"0.20000":[{"family":"NimbusSans","size":11,"w":40,"h":8,"bits":"HjzP43kSZEkiSTPmeTbPM6B5Ns8zmHk2zzOMeTbPEgZJIkmefs/jeQ=="},{"family":"NimbusSans","size":12,"w":43,"h":9,"bits":"HHA4DoezQWbbbLYII1EkEkcAjaPROAJkHI3GERjjaDSKYBBFIlGGgSyTyRz9OA6HAw=="},{"family":"NimbusSans","size":13,"w":47,"h":10,"bits":"HOBxODgcG5hsNjabCMQiEZFIDGKxmFg8Bth4bDweA2Y8Nh6PgTEeG49FYBCJiEQ2GNhsbDaO/TkcHA4="},{"family":"NimbusSans","size":14,"w":50,"h":10,"bits":"PMDj4eHh2YDZxsbGJgZCMTExsRAIhYSEhEMAHhoaGg4BbmhoaCgEDCEhIaEYGMTExMRmIjAzMzPz2J+Hh4cH"},{"family":"NimbusRoman","size":13,"w":42,"h":9,"bits":"HHgcjsPJIMlkmTwCPBpH4wjQaByNI0CjcTSOgIzG0TgCMRpHowyATJbJHPkcjsMB"},{"family":"NimbusRoman","size":14,"w":46,"h":10,"bits":"HOBwOByOCGQikUgkgphIJBKNATYej8djgI3H4/EYIOPxeDwGxHg8HouAIBKJRCIRikQiEcd8HA6HAw=="},{"family":"NimbusRoman","size":15,"w":48,"h":10,"bits":"HODgcHA4JpAxmZhMYggRi4nFYwAZj43HYwAZj43HY4AYj43HY0AYj43HYiAQi4nFJiIymZhMPPbj8fB4"},{"family":"DejaVuSans","size":11,"w":44,"h":8,"bits":"Dng4HA63gcxms9kRgEQikRgBTCQSiRFgRCKRGAFDJBKJGxhsNpvtiI/D4XA="},{"family":"DejaVuSans","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E8iYmExMMYCJicXEMYCIicXEMcCIicXEMWCIicXEMTCIicXEExuYmExMHvvx8Hh4"},{"family":"DejaVuSans","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMxZmZmZiMAY2RkZBQGMMLCwsJhgCEsLCwcBgzCwsLCI2BgZGRkNDMDZmZmZh7zw8PDwwM="},{"family":"DejaVuSerif","size":11,"w":44,"h":8,"bits":"Dng4HA63gcxms9kRwEQikRgBRCQSiRFgRCKRGAFDJBKJG5hsNpvtmI/D4XA="},{"family":"DejaVuSerif","size":12,"w":48,"h":9,"bits":"Hnjw8Hh4E8iYmExMMYCIicXEMYCIicXEMcCIicXEMWCIicXEMTCIicXEExuZmExMHvvx8Hh4"},{"family":"DejaVuSerif","size":13,"w":52,"h":9,"bits":"HuDBw8PDMwMzZmZmZiMQY2RkZBQCMEJCQkJhACEsLCwcAghCQkJCI0BgZGRkNDMiZmZmZh7zw8PDwwM="}]};

},
'core_v2_axis_consensus2.js': function(module,exports,require){
'use strict';
const median=a=>{if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
function fitAffine(anchors){
  if(!Array.isArray(anchors)||anchors.length<2)throw Error('Needs attention: fewer than two Y anchors.');
  const ys=anchors.map(a=>a.y),vs=anchors.map(a=>a.value),n=ys.length,my=ys.reduce((a,b)=>a+b,0)/n,mv=vs.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;for(let i=0;i<n;i++){num+=(ys[i]-my)*(vs[i]-mv);den+=(ys[i]-my)**2}
  if(!(den>0))throw Error('Needs attention: degenerate axis anchors.');
  const slope=num/den,intercept=mv-slope*my,rmse=Math.sqrt(ys.reduce((s,y,i)=>s+(slope*y+intercept-vs[i])**2,0)/n);
  return{slope,intercept,rmse};
}
function solveView(rows,opts={}){
  const usable=rows.filter(r=>Array.isArray(r.hyps)&&r.hyps.length);
  if(usable.length<2)return null;
  let best=null,second=null;
  for(let i=0;i<usable.length;i++)for(let j=i+1;j<usable.length;j++){
    const A=usable[i],B=usable[j],dy=B.y-A.y;if(Math.abs(dy)<4)continue;
    for(const ha of A.hyps.slice(0,opts.maxHyps||7))for(const hb of B.hyps.slice(0,opts.maxHyps||7)){
      const slope=(hb.value-ha.value)/dy;if(!Number.isFinite(slope)||slope>=0)continue;
      const intercept=ha.value-slope*A.y,step=Math.abs(slope*(opts.gridStepPx||1));
      if(!(step>1e-7&&step<(opts.maxStep||20)))continue;
      let score=0,support=0,anchors=[];
      for(const row of usable){
        const pred=slope*row.y+intercept;let qbest=null;
        for(const h of row.hyps.slice(0,opts.maxHyps||7)){
          const err=Math.abs(h.value-pred)/Math.max(step,1e-12);
          if(!qbest||err<qbest.err)qbest={...h,err};
        }
        if(qbest&&qbest.err<=(opts.anchorToleranceSteps??.20)){
          support++;score+=4+2*(qbest.conf||0)-2*qbest.err;anchors.push({y:row.y,value:qbest.value,conf:qbest.conf||0,err:qbest.err,text:qbest.text});
        }
      }
      const need=Math.max(2,Math.ceil(usable.length*(opts.minSupportFrac??.60)));
      if(support<need)continue;
      // favor models backed by independent rows, not just a perfect pair
      score+=support*1.6;
      const rec={slope,intercept,step,support,score,anchors};
      if(!best||score>best.score){second=best;best=rec}else if(!second||score>second.score)second=rec;
    }
  }
  if(!best)return null;
  best.margin=second?best.score-second.score:99;
  return best;
}
function modelDistance(a,b,yRef,stepRef){
  const va=a.slope*yRef+a.intercept,vb=b.slope*yRef+b.intercept;
  const valueSteps=Math.abs(va-vb)/Math.max(stepRef,1e-12);
  const stepRatio=Math.abs(Math.log(Math.max(a.step,1e-12)/Math.max(b.step,1e-12)));
  return{valueSteps,stepRatio};
}
function consensus(viewSolutions,opts={}){
  const sols=viewSolutions.filter(Boolean);
  const minViews=opts.minViews??3;
  if(sols.length<minViews)return{accepted:false,reason:'axis views did not all resolve'};
  const yRef=opts.yRef??median(sols.flatMap(s=>s.anchors.map(a=>a.y)));
  const stepRef=median(sols.map(s=>s.step));
  let worstV=0,worstR=0;
  for(let i=0;i<sols.length;i++)for(let j=i+1;j<sols.length;j++){
    const d=modelDistance(sols[i],sols[j],yRef,stepRef);worstV=Math.max(worstV,d.valueSteps);worstR=Math.max(worstR,d.stepRatio);
  }
  if(worstV>(opts.maxViewValueSteps??.18)||worstR>(opts.maxViewStepLogRatio??.12))return{accepted:false,reason:'axis views disagree',worstValueSteps:worstV,worstStepLogRatio:worstR};
  if(sols.some(s=>s.margin<(opts.minMargin??.30)))return{accepted:false,reason:'axis hypothesis margin too small'};
  const byRow=new Map();
  for(const s of sols)for(const a of s.anchors){const key=Math.round(a.y*2)/2;if(!byRow.has(key))byRow.set(key,[]);byRow.get(key).push(a)}
  const anchors=[];
  for(const [y,as] of byRow){if(as.length<minViews)continue;const vals=as.map(a=>a.value),v=median(vals),spread=Math.max(...vals)-Math.min(...vals);if(spread/Math.max(stepRef,1e-12)>(opts.maxAnchorSpreadSteps??.12))continue;anchors.push({y,value:v,conf:median(as.map(a=>a.conf))});}
  if(anchors.length<2)return{accepted:false,reason:'fewer than two cross-view anchor rows'};
  anchors.sort((a,b)=>a.y-b.y);
  const fit=fitAffine(anchors),normRmse=fit.rmse/Math.max(stepRef,1e-12);
  const ds=anchors.slice(1).map((a,i)=>a.y-anchors[i].y),dm=ds.reduce((a,b)=>a+b,0)/ds.length,spacingCv=ds.length>1?Math.sqrt(ds.reduce((s,d)=>s+(d-dm)**2,0)/ds.length)/Math.max(dm,1e-9):0;
  if(!(fit.slope<0)||normRmse>(opts.maxNormRmse??.08)||spacingCv>(opts.maxSpacingCv??.16))return{accepted:false,reason:'affine validation failed',normRmse,spacingCv};
  return{accepted:true,rows:anchors.map(a=>a.y),values:anchors.map(a=>a.value),slope:fit.slope,intercept:fit.intercept,step:stepRef,normRmse,spacingCv,views:sols.length,worstValueSteps:worstV,worstStepLogRatio:worstR};
}
function resolveFromViews(views,opts={}){
  const sols=views.map(v=>solveView(v.rows,{...opts,gridStepPx:v.gridStepPx??opts.gridStepPx}));
  return consensus(sols,opts);
}
module.exports={fitAffine,solveView,consensus,resolveFromViews,modelDistance};

},
'core_v2_axis_resolver34g_inkcenter_preserve_memo.js': function(module,exports,require){
'use strict';
const C=require('./core_v2_axis_gui_candidate10_preserve_memo.js');
const CE=require('./core_v2_compact_empirical_evidence.js');
const AX=require('./core_v2_axis_consensus2.js');
const DEC=[];for(let i=0;i<=40;i++){const v=i*.005;DEC.push({text:(Math.abs(v)<5e-10?0:v).toFixed(5),value:v,formatSig:'fixed:5'})}
const COMPACT=[];for(let i=0;i<=200;i++){const v=i*.1;COMPACT.push({text:(Math.abs(v)<5e-10?0:v).toFixed(1),value:v,formatSig:'fixed:1'})}
function longestRun(row){let b=0,c=0;for(const z of row){c=z?c+1:0;if(c>b)b=c}return b}
function axisIntersectionFallback(img,plot,view={}){
  const W=img.width,H=img.height,d=img.data,rows=(plot.h||[]).filter(Number.isFinite);
  if(rows.length<2)return null;
  const hits=[];
  for(const yy of rows){
    let best=null;
    for(let dx=-10;dx<=10;dx++){
      const x=Math.round(plot.left+dx); if(x<1||x>=W-1)continue;
      let score=0;
      // Require a horizontal grid crossing, not merely a vertical text stroke.
      for(let sx=-5;sx<=5;sx++){
        const xx=x+sx;if(xx<0||xx>=W)continue;
        for(let dy=-2;dy<=2;dy++){
          const y=Math.round(yy+dy);if(y<0||y>=H)continue;
          const i=(y*W+xx)*4;if(C.green(d[i],d[i+1],d[i+2],view)){score++;break}
        }
      }
      if(!best||score>best.score)best={x,score};
    }
    if(best&&best.score>=6)hits.push(best);
  }
  if(hits.length<2)return null;
  const xs=hits.map(q=>q.x).sort((a,b)=>a-b),med=xs[Math.floor(xs.length/2)];
  if(Math.max(...xs)-Math.min(...xs)>14)return null;
  if(Math.abs(med-plot.left)>10)return null;
  return med;
}
function refineAxisX(img,plot,view={}){const W=img.width,H=img.height,d=img.data,lo=Math.max(0,Math.floor(plot.left-18)),hi=Math.min(W-1,Math.ceil(plot.left+10)),rec=[];for(let x=lo;x<=hi;x++){let best=0,cur=0;for(let y=0;y<H;y++){const i=(y*W+x)*4,ok=C.green(d[i],d[i+1],d[i+2],view);cur=ok?cur+1:0;if(cur>best)best=cur}rec.push({x,run:best})}rec.sort((a,b)=>b.run-a.run);if(!rec.length||rec[0].run<30)return axisIntersectionFallback(img,plot,view);const thr=Math.max(30,rec[0].run*.68),xs=rec.filter(r=>r.run>=thr).map(r=>r.x).sort((a,b)=>a-b);let groups=[],g=[];for(const x of xs){if(!g.length||x-g[g.length-1]<=2)g.push(x);else{groups.push(g);g=[x]}}if(g.length)groups.push(g);groups.sort((a,b)=>b.length-a.length);const q=groups[0];return q.reduce((s,x)=>s+x,0)/q.length}
function rawReadableRows(img,plot,view={}){const W=img.width,H=img.height,d=img.data,x0=Math.max(0,Math.round(plot.left)),x1=Math.min(W-1,Math.round(plot.right)),old=plot.h||[],lo=Math.max(0,Math.floor((old.length?Math.min(...old):0)-90)),hi=Math.min(H-1,Math.ceil((old.length?Math.max(...old):H-1)+30)),cand=[];for(let y=lo;y<=hi;y++){const row=[];let sum=0;for(let x=x0;x<=x1;x++){const i=(y*W+x)*4,z=C.green(d[i],d[i+1],d[i+2],view)?1:0;row.push(z);sum+=z}const run=longestRun(row);if(run>=Math.max(30,(x1-x0)*.34)||sum>=Math.max(42,(x1-x0)*.30))cand.push({y,run,sum})}const groups=[];for(const r of cand){if(!groups.length||r.y-groups.at(-1).at(-1).y>2)groups.push([r]);else groups.at(-1).push(r)}return groups.map(g=>g.sort((a,b)=>(b.sum+b.run*.35)-(a.sum+a.run*.35))[0]).sort((a,b)=>a.y-b.y)}
function inferGridIndices(rows){if(rows.length<2)return rows;const ds=[];for(let i=1;i<rows.length;i++){const d=rows[i].y-rows[i-1].y;if(d>=12&&d<=120)for(let k=1;k<=4;k++){const b=d/k;if(b>=12&&b<=100)ds.push(b)}}let best=null;for(const base of ds){let err=0,uniq=new Set();for(const r of rows){const q=(r.y-rows[0].y)/base,n=Math.round(q);err+=Math.abs(q-n);uniq.add(n)}const score=err+Math.max(0,rows.length-uniq.size)*2;if(!best||score<best.score)best={base,score}}const base=best?.base||((rows.at(-1).y-rows[0].y)/(rows.length-1));const out=[];for(const r of rows){const gi=Math.round((r.y-rows[0].y)/base);if(out.some(q=>q.gridIndex===gi))continue;out.push({...r,gridIndex:gi,base})}return out}

function labelInkCenter(img,plot,gridY,view={}){const W=img.width,H=img.height,d=img.data,x1=Math.max(2,Math.round(plot.left-(view.xGap??4))),span=Math.max(48,Math.min(70,Math.round((plot.right-plot.left)*(view.spanFrac??.34)))),x0=Math.max(0,x1-span),y0=Math.max(0,Math.round(gridY-11)),y1=Math.min(H-1,Math.round(gridY+11)),rows=[];let mx=0;for(let y=y0;y<=y1;y++){let n=0;for(let x=x0;x<=x1;x++){const i=(y*W+x)*4;if(C.green(d[i],d[i+1],d[i+2],view))n++}rows.push({y,n});if(n>mx)mx=n}if(mx<3)return gridY;const thr=Math.max(2,mx*.15),groups=[];let g=[];for(const r of rows){if(r.n>=thr){if(!g.length||r.y-g[g.length-1].y<=1)g.push(r);else{groups.push(g);g=[r]}}else if(g.length){groups.push(g);g=[]}}if(g.length)groups.push(g);if(!groups.length)return gridY;let best=null;for(const q of groups){const sum=q.reduce((a,b)=>a+b.n,0),cy=q.reduce((a,b)=>a+b.y*b.n,0)/Math.max(1,sum),dist=Math.abs(cy-gridY),score=sum-dist*1.8;if(!best||score>best.score)best={cy,score,sum,dist}}return Math.round(best.cy)}
function readableRows(img,plot,view={}){const raw=rawReadableRows(img,plot,view);if(raw.length<2)return[];const approx=[];for(let i=1;i<raw.length;i++){const d=raw[i].y-raw[i-1].y;if(d>=12&&d<=100)approx.push(d)}const rs=approx.length?approx.sort((a,b)=>a-b)[Math.floor(approx.length/2)]:30;const kept=[];for(const r of raw){const labelY=labelInkCenter(img,plot,r.y,view),m=C.rowMask(img,plot,labelY,rs,view),aspect=C.labelAspect(m);if(!(aspect>=2.8))continue;const pool=C.guiScorePool(m,DEC,3),top=pool[0]?.score||0;if(top<.43)continue;kept.push({...r,labelY,aspect,quality:top+Math.min(aspect,7)*.004})}return inferGridIndices(kept)}

function readableRowsCompact(img,plot,view={}){
  const raw=rawReadableRows(img,plot,view);if(raw.length<3)return[];
  const approx=[];for(let i=1;i<raw.length;i++){const d=raw[i].y-raw[i-1].y;if(d>=12&&d<=120)approx.push(d)}
  const rs=approx.length?approx.sort((a,b)=>a-b)[Math.floor(approx.length/2)]:30,kept=[];
  for(const r of raw){
    const labelY=labelInkCenter(img,plot,r.y,view),m=C.rowMask(img,plot,labelY,rs,view),aspect=C.labelAspect(m);
    if(!(aspect>=1.15&&aspect<=4.2))continue;
    const pool=C.scorePool(m,COMPACT,4),top=pool[0]?.score||0;
    if(top<.46)continue;
    kept.push({...r,labelY,aspect,quality:top});
  }
  return inferGridIndices(kept);
}

function readableRowsCompactUnit(img,plot,view={}){
  const hs=(plot.h||[]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(hs.length<2)return[];
  const rs=plot.hStep||((hs.at(-1)-hs[0])/Math.max(1,hs.length-1));
  const rows=[];
  for(let i=0;i<hs.length;i++){
    const y=hs[i],labelY=labelInkCenter(img,plot,y,view),m=C.rowMask(img,plot,labelY,rs,view),aspect=C.labelAspect(m);
    const pool=C.scorePool(m,COMPACT.filter(q=>q.text.endsWith('.0')),8),top=pool[0]?.score||0;
    if(top<.43)continue;
    rows.push({y,labelY,aspect,quality:top,gridIndex:i,base:rs});
  }
  return rows;
}
function solveViewCompactUnit(img,plot,view){
  const ax=Number.isFinite(view.forceAxisX)?view.forceAxisX:refineAxisX(img,plot,view);if(!Number.isFinite(ax))return null;
  const p={...plot,left:ax},rows=readableRowsCompactUnit(img,p,view);if(rows.length<2)return null;
  const stepPx=plot.hStep||((rows.at(-1).y-rows[0].y)/Math.max(1,rows.length-1));
  const masks=rows.map(r=>C.rowMask(img,p,r.labelY??r.y,stepPx,view));
  const unit=COMPACT.filter(q=>q.text.endsWith('.0'));
  const pools=masks.map(m=>C.scorePool(m,unit,12));if(pools.some(q=>!q.length))return null;
  const hyps=[];
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const di=rows[j].gridIndex-rows[i].gridIndex;if(!(di>0))continue;
    for(const a of pools[i])for(const b of pools[j]){
      const st=(a.value-b.value)/di;if(Math.abs(st-1)>1e-7)continue;
      const anchors=[];let total=0;
      for(let k=0;k<rows.length;k++){
        const val=a.value-(rows[k].gridIndex-rows[i].gridIndex);
        if(val<-1e-8||val>20.000001||Math.abs(val-Math.round(val))>1e-7)continue;
        const text=(Math.abs(val)<5e-10?0:val).toFixed(1),z=C.detail(masks[k],text);
        const emp=Number.isInteger(view.empiricalView)?CE.scoreRow(masks[k],text,view.empiricalView):null;
        if(!z||z.score<.43||!(emp>=.38))continue;
        total+=z.score*.35+emp*.65+.08*(z.charMean||0);
        anchors.push({y:rows[k].y,value:val,conf:Math.min(z.score,emp),text,charMean:z.charMean||0,empirical:emp});
      }
      if(anchors.length<2)continue;
      const fit=AX.fitAffine(anchors),score=total+anchors.length*.22-(fit.rmse)*.35;
      hyps.push({slope:fit.slope,intercept:fit.intercept,step:1,support:anchors.length,score,anchors,axisX:ax,rows});
    }
  }
  hyps.sort((a,b)=>b.score-a.score);if(!hyps.length)return null;
  const best=hyps[0],second=hyps.find(h=>Math.abs((h.intercept-best.intercept))>.15);
  best.margin=second?best.score-second.score:99;
  best.alt=second?{step:second.step,score:second.score,anchors:second.anchors}:null;
  return best;
}

function compactNiceStep(x){
  if(!(x>=.099999&&x<=20))return false;
  const mag=10**Math.floor(Math.log10(x)),m=x/mag;
  return Math.min(...[1,2,2.5,5,10].map(q=>Math.abs(m-q)/q))<=.04;
}
function solveViewCompact(img,plot,view){
  const ax=refineAxisX(img,plot,view);if(!Number.isFinite(ax))return null;
  const p={...plot,left:ax},rows=readableRowsCompact(img,p,view);if(rows.length<3)return null;
  const stepPx=(rows.at(-1).y-rows[0].y)/Math.max(1,rows.length-1);
  const masks=rows.map(r=>C.rowMask(img,p,r.labelY??r.y,stepPx,view));
  const pools=masks.map(m=>C.scorePool(m,COMPACT,12));
  if(pools.some(q=>!q.length))return null;
  const hyps=[];
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const di=rows[j].gridIndex-rows[i].gridIndex;if(!(di>0))continue;
    for(const a of pools[i])for(const b of pools[j]){
      const st=(a.value-b.value)/di;if(!(st>0)||!compactNiceStep(st))continue;
      const anchors=[];let total=0;
      for(let k=0;k<rows.length;k++){
        const val=a.value-st*(rows[k].gridIndex-rows[i].gridIndex);
        if(val<-1e-8||val>20.000001||Math.abs(val*10-Math.round(val*10))>1e-7)continue;
        const text=(Math.abs(val)<5e-10?0:val).toFixed(1);
        const z=C.detail(masks[k],text);if(!z||z.score<.46)continue;
        total+=z.score+.10*(z.charMean||0);
        anchors.push({y:rows[k].y,value:val,conf:z.score,text,charMean:z.charMean||0});
      }
      if(anchors.length<3)continue;
      const fit=AX.fitAffine(anchors);
      const score=total+anchors.length*.18-(fit.rmse/Math.max(st,1e-12))*.25;
      hyps.push({slope:fit.slope,intercept:fit.intercept,step:st,support:anchors.length,score,anchors,axisX:ax,rows,aspect:rows.map(r=>r.aspect).reduce((s,v)=>s+v,0)/rows.length});
    }
  }
  hyps.sort((a,b)=>b.score-a.score);if(!hyps.length)return null;
  const best=hyps[0],second=hyps.find(h=>Math.abs(h.step-best.step)>best.step*.05||Math.abs((h.intercept-best.intercept)/(best.step||1))>.15);
  best.margin=second?best.score-second.score:99;
  best.alt=second?{step:second.step,score:second.score,anchors:second.anchors}:null;
  return best;
}

function niceStep(x){if(!(x>1e-7&&x<10))return false;const mag=10**Math.floor(Math.log10(x)),m=x/mag;return Math.min(...[1,2,2.5,5,10].map(q=>Math.abs(m-q)/q))<=.06}
function solveView(img,plot,view){const ax=refineAxisX(img,plot,view);if(!Number.isFinite(ax))return null;const p={...plot,left:ax};const rows=readableRows(img,p,view);if(rows.length<2)return null;const stepPx=rows.length>1?(rows.at(-1).y-rows[0].y)/(rows.length-1):30;const masks=rows.map(r=>C.rowMask(img,p,r.labelY??r.y,stepPx,view)),aspects=masks.map(C.labelAspect).filter(Number.isFinite);const aspect=aspects.length?aspects.sort((a,b)=>a-b)[Math.floor(aspects.length/2)]:NaN;if(!(aspect>=2.8))return null;const pools=masks.map(m=>C.guiScorePool(m,DEC,16));const rankMaps=pools.map(pool=>new Map(pool.map((q,idx)=>[q.text,idx])));const hyps=[];for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){const di=rows[j].gridIndex-rows[i].gridIndex;for(const a of pools[i])for(const b of pools[j]){const st=(a.value-b.value)/di;if(!(st>0)||!niceStep(st))continue;const pred=[];for(let k=0;k<rows.length;k++){const val=a.value-st*(rows[k].gridIndex-rows[i].gridIndex),text=(Math.abs(val)<5e-10?0:val).toFixed(5);if(val<-1e-9||val>.200001)continue;pred.push({k,val,text,styles:C.styleMap(masks[k],text)})}if(pred.length<2)continue;const styleKeys=new Set();for(const q of pred)for(const key of q.styles.keys())styleKeys.add(key);let bestStyle=null;for(const key of styleKeys){let total=0,support=0,anchors=[];for(const q of pred){const z=q.styles.get(key);if(!z||z.score<.43)continue;support++;total+=z.score;anchors.push({y:rows[q.k].y,value:q.val,conf:z.score,text:q.text,rank:rankMaps[q.k].get(q.text)})}if(support<2)continue;let rankBonus=0;for(const an of anchors){const k=rows.findIndex(r=>Math.abs(r.y-an.y)<.5),rk=k>=0?rankMaps[k].get(an.text):undefined;if(rk===0)rankBonus+=.018;else if(rk===1)rankBonus+=.012;else if(rk===2)rankBonus+=.006;}const fit=AX.fitAffine(anchors),score=total*1.28+support*.08+rankBonus;if(!bestStyle||score>bestStyle.score)bestStyle={score,support,anchors,fit,style:key,rankBonus}}if(!bestStyle)continue;hyps.push({slope:bestStyle.fit.slope,intercept:bestStyle.fit.intercept,step:st,support:bestStyle.support,score:bestStyle.score,anchors:bestStyle.anchors,style:bestStyle.style,rankBonus:bestStyle.rankBonus,axisX:ax,rows,aspect})}}
  hyps.sort((a,b)=>b.score-a.score);if(!hyps.length)return null;const best=hyps[0],second=hyps.find(h=>Math.abs(h.step-best.step)>best.step*.05||Math.abs((h.intercept-best.intercept)/(best.step||1))>.15);best.margin=second?best.score-second.score:99;best.alt=second?{step:second.step,score:second.score,anchors:second.anchors}:null;return best}
function resolve(img,plot){const views=[{gmin:46,diff:6,ratio:1.06,lum:28},{gmin:50,diff:8,ratio:1.08,lum:30},{gmin:52,diff:8,ratio:1.08,lum:30}],sols=views.map(v=>solveView(img,plot,v));const out=AX.consensus(sols,{minViews:3,maxViewValueSteps:.12,maxViewStepLogRatio:.08,minMargin:.018,maxAnchorSpreadSteps:.12,maxNormRmse:.08,maxSpacingCv:.16});out.diagnostics={mode:'affine-gui-style-rank-label-center-v34',viewResolved:sols.map(Boolean),step:sols.map(s=>s?.step??null),margin:sols.map(s=>s?.margin??null),axisX:sols.map(s=>s?.axisX??null),rows:sols.map(s=>s?.rows?.map(r=>r.y)??[]),anchors:sols.map(s=>s?.anchors??[])};return out}
module.exports={resolve,solveView,solveViewCompact,solveViewCompactUnit,compactNiceStep,refineAxisX,axisIntersectionFallback,readableRows,readableRowsCompact,readableRowsCompactUnit,labelInkCenter};

},
'core_v2_axis_gui_candidate10_preserve_memo.js': function(module,exports,require){
'use strict';
const BASE=require('./core_v2_axis_glyph_candidate4_preserve_strokes.js');
const BANK=require('./core_v2_gui_numeric_bank.js');
const decoded=new Map();
const rowCache=new WeakMap();
const detailCache=new WeakMap();
function unpack(t){let k=t.family+':'+t.size+':'+t.w+'x'+t.h+':'+t.bits;if(decoded.has(k))return decoded.get(k);const b=(typeof Buffer!=='undefined'&&Buffer.from)?Buffer.from(t.bits,'base64'):(()=>{const s=atob(t.bits),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u})(),a=new Uint8Array(t.w*t.h),ones=[];for(let i=0;i<a.length;i++){const v=(b[i>>3]>>(i&7))&1;a[i]=v;if(v)ones.push([i%t.w,Math.floor(i/t.w)])}const z={...t,data:a,ones,tc:ones.length};decoded.set(k,z);return z}
function rowStats(row){let z=rowCache.get(row);if(z)return z;const stride=row.w+1,ii=new Uint32Array((row.w+1)*(row.h+1));for(let y=0;y<row.h;y++){let rs=0;for(let x=0;x<row.w;x++){rs+=row.data[y*row.w+x]?1:0;ii[(y+1)*stride+(x+1)]=ii[y*stride+(x+1)]+rs}}z={ii,stride};rowCache.set(row,z);return z}
function rectSum(st,x,y,w,h){const {ii,stride}=st,x2=x+w,y2=y+h;return ii[y2*stride+x2]-ii[y*stride+x2]-ii[y2*stride+x]+ii[y*stride+x]}
function templateScore(row,t){t=unpack(t);if(t.h>row.h||t.w>row.w)return null;const st=rowStats(row),tc=t.tc;if(tc<5)return null;let best=null;const xlo=Math.max(0,row.w-t.w-18),xhi=row.w-t.w;for(let yy=0;yy<=row.h-t.h;yy++)for(let x=xlo;x<=xhi;x++){let tp=0;for(const [dx,dy] of t.ones)if(row.data[(yy+dy)*row.w+x+dx])tp++;const obs=rectSum(st,x,yy,t.w,t.h),rec=tp/tc,prec=tp/Math.max(1,obs),score=.70*rec+.30*prec;if(!best||score>best.score)best={score,rec,prec,x,yy,family:t.family,size:t.size}}return best}
function guiDetails(row,text){let m=detailCache.get(row);if(!m){m=new Map();detailCache.set(row,m)}if(m.has(text))return m.get(text);const ts=BANK[text];if(!ts){m.set(text,[]);return []}const out=[];for(const t of ts){const z=templateScore(row,t);if(z)out.push(z)}out.sort((a,b)=>b.score-a.score);m.set(text,out);return out}
function guiDetail(row,text){return guiDetails(row,text)[0]||null}
function styleMap(row,text){const m=new Map();for(const z of guiDetails(row,text))m.set(z.family+':'+z.size,z);return m}
function guiScorePool(row,pool,limit=14){const out=[];for(const c of pool){const z=guiDetail(row,c.text);if(z)out.push({...c,score:z.score,gui:z})}out.sort((a,b)=>b.score-a.score);return out.slice(0,limit)}
module.exports={...BASE,guiDetail,guiDetails,styleMap,guiScorePool,templateScore};

},
'core_v2_axis_glyph_candidate4_preserve_strokes.js': function(module,exports,require){
'use strict';
const FONT={'0':["11111","10001","10011","10101","11001","10001","11111"],'1':["00100","01100","00100","00100","00100","00100","01110"],'2':["11110","00001","00001","11110","10000","10000","11111"],'3':["11110","00001","00001","01110","00001","00001","11110"],'4':["10010","10010","10010","11111","00010","00010","00010"],'5':["11111","10000","10000","11110","00001","00001","11110"],'6':["01111","10000","10000","11110","10001","10001","01110"],'7':["11111","00001","00010","00100","01000","01000","01000"],'8':["01110","10001","10001","01110","10001","10001","01110"],'9':["01110","10001","10001","01111","00001","00001","11110"],'.':["0","0","0","0","0","0","1"],'-':["00000","00000","00000","11111","00000","00000","00000"]};
function green(r,g,b,v={}){const mx=Math.max(r,b);return g>(v.gmin??42)&&(g-mx)>=(v.diff??5)&&g>=mx*(v.ratio??1.05)&&(.299*r+.587*g+.114*b)>(v.lum??28)}
function rasterText(text,gap=1){let gs=[],ranges=[],ox=0;for(const ch of text){const q=FONT[ch];if(q)gs.push(q)}const H=7,W=gs.reduce((s,g)=>s+g[0].length,0)+gap*Math.max(0,gs.length-1),a=new Uint8Array(W*H);for(let gi=0;gi<gs.length;gi++){const g=gs[gi],st=ox;for(let y=0;y<H;y++)for(let x=0;x<g[y].length;x++)if(g[y][x]==='1')a[y*W+ox+x]=1;ox+=g[0].length;ranges.push([st,ox-1]);if(gi<gs.length-1)ox+=gap}return{data:a,w:W,h:H,ranges}}
function scaled(t,sc){const w=Math.max(1,Math.round(t.w*sc)),h=Math.max(1,Math.round(t.h*sc)),a=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=Math.min(t.w-1,Math.floor(x/sc)),sy=Math.min(t.h-1,Math.floor(y/sc));a[y*w+x]=t.data[sy*t.w+sx]}return{data:a,w,h,ranges:t.ranges.map(([a,b])=>[Math.floor(a*sc),Math.min(w-1,Math.ceil((b+1)*sc)-1)])}}
function rowMask(img,plot,y,rowStep,view={}){const W=img.width,H=img.height,d=img.data,rs=Math.max(12,rowStep||28),x1=Math.max(2,Math.round(plot.left-(view.xGap??4))),span=Math.max(48,Math.min(70,Math.round((plot.right-plot.left)*(view.spanFrac??.34)))),x0=Math.max(0,x1-span),half=Math.max(8,Math.min(15,Math.round(rs*(view.halfFrac??.40)))),y0=Math.max(0,Math.round(y-half)),y1=Math.min(H-1,Math.round(y+half)),w=x1-x0+1,h=y1-y0+1,a=new Uint8Array(w*h);for(let yy=y0;yy<=y1;yy++)for(let x=x0;x<=x1;x++){const i=(yy*W+x)*4;if(green(d[i],d[i+1],d[i+2],view))a[(yy-y0)*w+(x-x0)]=1}return{data:a,w,h,x0,y0}}
function detail(row,text){let best=null;for(const gap of [1,2]){const rb=rasterText(text,gap);for(const sc of [1,1.25,1.5,1.75,2,2.25,2.5,2.75,3]){const t=scaled(rb,sc);if(t.h>row.h*.94||t.w>row.w*.99)continue;const yc=Math.floor(row.h/2),yMin=Math.max(0,Math.round(yc-t.h*.78)),yMax=Math.min(row.h-t.h,Math.round(yc-t.h*.18));for(let yy=yMin;yy<=yMax;yy++)for(let off=0;off<=12;off++){const x=row.w-t.w-off;if(x<0)continue;let tp=0,obs=0,tc=0;for(let y=0;y<t.h;y++)for(let xx=0;xx<t.w;xx++){const tv=t.data[y*t.w+xx],ov=row.data[(yy+y)*row.w+(x+xx)];if(tv)tc++;if(ov)obs++;if(tv&&ov)tp++}if(tc<4)continue;const rec=tp/tc,prec=tp/Math.max(1,obs),score=rec*.7+prec*.3;if(!best||score>best.score)best={score,rec,prec,x,yy,t,sc,gap}}}}if(!best)return null;let chars=[];for(const [a,b] of best.t.ranges){let tp=0,tc=0,obs=0;for(let y=0;y<best.t.h;y++)for(let xx=a;xx<=b;xx++){const tv=best.t.data[y*best.t.w+xx],ov=row.data[(best.yy+y)*row.w+(best.x+xx)];if(tv)tc++;if(ov)obs++;if(tv&&ov)tp++}const rec=tp/Math.max(1,tc),prec=tp/Math.max(1,obs);chars.push(.7*rec+.3*prec)}best.charMean=chars.length?chars.reduce((s,v)=>s+v,0)/chars.length:0;best.charScores=chars;return best}

function fixedDetail(row,text,alignText='0.00000'){
  const a=detail(row,alignText);if(!a)return null;
  const t=scaled(rasterText(text,a.gap),a.sc);if(t.w!==a.t.w||t.h!==a.t.h)return null;
  let tp=0,obs=0,tc=0,chars=[];
  for(let y=0;y<t.h;y++)for(let x=0;x<t.w;x++){const tv=t.data[y*t.w+x],ov=row.data[(a.yy+y)*row.w+(a.x+x)];if(tv)tc++;if(ov)obs++;if(tv&&ov)tp++}
  for(const [u,v] of t.ranges){let p=0,c=0,o=0;for(let y=0;y<t.h;y++)for(let x=u;x<=v;x++){const tv=t.data[y*t.w+x],ov=row.data[(a.yy+y)*row.w+(a.x+x)];if(tv)c++;if(ov)o++;if(tv&&ov)p++}
    chars.push(.7*p/Math.max(1,c)+.3*p/Math.max(1,o));
  }
  return{score:.7*tp/Math.max(1,tc)+.3*tp/Math.max(1,obs),charMean:chars.reduce((q,z)=>q+z,0)/Math.max(1,chars.length),
    charScores:chars,x:a.x,yy:a.yy,sc:a.sc,gap:a.gap};
}

function score(row,text){return detail(row,text)?.score||0}
function scorePool(row,pool,limit=12){const out=[];for(const c of pool){const z=detail(row,c.text);if(z)out.push({...c,score:z.score,charMean:z.charMean})}out.sort((a,b)=>(b.score+.18*b.charMean)-(a.score+.18*a.charMean));return out.slice(0,limit)}
function labelAspect(row){const cols=new Int16Array(row.w);for(let y=0;y<row.h;y++)for(let x=0;x<row.w;x++)if(row.data[y*row.w+x])cols[x]++;let runs=[],a=-1,gap=0;for(let x=0;x<row.w;x++){if(cols[x]){if(a<0)a=x;gap=0}else if(a>=0){gap++;if(gap>Math.max(3,Math.round(row.h*.22))){runs.push([a,x-gap]);a=-1;gap=0}}}if(a>=0)runs.push([a,row.w-1]);if(!runs.length)return NaN;let q=runs.sort((u,v)=>v[1]-u[1])[0],ys=[];for(let y=0;y<row.h;y++)for(let x=q[0];x<=q[1];x++)if(row.data[y*row.w+x])ys.push(y);if(!ys.length)return NaN;return(q[1]-q[0]+1)/(Math.max(...ys)-Math.min(...ys)+1)}
module.exports={rowMask,detail,fixedDetail,score,scorePool,labelAspect,green};

},
'core_v2_compact_empirical_evidence.js': function(module,exports,require){

'use strict';
const BANK=require('./core_v2_compact_empirical_bank.js');
const decoded=new Map();
function unpack(p){if(decoded.has(p))return decoded.get(p);const b=(typeof Buffer!=='undefined'&&Buffer.from)?Buffer.from(p.bits,'base64'):(()=>{const s=atob(p.bits),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u})(),a=new Uint8Array(BANK.w*BANK.h);for(let i=0;i<a.length;i++)a[i]=(b[i>>3]>>(i&7))&1;decoded.set(p,a);return a}
function normalize(row,W=BANK.w,H=BANK.h){let x0=row.w,y0=row.h,x1=-1,y1=-1;for(let y=0;y<row.h;y++)for(let x=0;x<row.w;x++)if(row.data[y*row.w+x]){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}if(x1<0)return null;const a=new Uint8Array(W*H);for(let y=0;y<H;y++){const sy=Math.round(y0+(y1-y0)*(H===1?0:y/(H-1)));for(let x=0;x<W;x++){const sx=Math.round(x0+(x1-x0)*(W===1?0:x/(W-1)));if(row.data[sy*row.w+sx])a[y*W+x]=1}}return a}
function dice(a,b){let i=0,aa=0,bb=0;for(let k=0;k<a.length;k++){if(a[k])aa++;if(b[k])bb++;if(a[k]&&b[k])i++;}return 2*i/Math.max(1,aa+bb)}
function scoreNormalized(a,label,view){const ps=(BANK.labels[label]||[]).filter(p=>p.view===view);const bySource=new Map();for(const p of ps){const s=dice(a,unpack(p)),old=bySource.get(p.source);if(old==null||s>old)bySource.set(p.source,s)}if(bySource.size<2)return null;const ss=[...bySource.values()].sort((x,y)=>y-x);return(ss[0]+ss[1])/2}
function scoreRow(row,label,view){const a=normalize(row);return a?scoreNormalized(a,label,view):null}
module.exports={BANK,normalize,dice,scoreNormalized,scoreRow};

},
'core_v2_compact_empirical_bank.js': function(module,exports,require){
'use strict';
module.exports={"w":64,"h":16,"labels":{"3.0":[{"view":0,"source":"field_01.jpeg","bits":"AAAEAOABAGAAAAcA4AEAQAAQPwDwAADAgM06APAAAMDAAHgA8AAA4ICIeADwAADggIB4APAEAMCAAXwA8AUAwIABdAD/L7vNgANwAP9v992AA3CA/22zzYADYADoLQDIgANwAOANAMCgjXgAgA0AwKf+PwDAAwDAA/AHAMADAMA="},{"view":1,"source":"field_01.jpeg","bits":"AAACAOAAAGAAgAcA4AAAQACAPwDgAADAACY5AOAAAEDgADgA4AAA4MBEeADgAADAgAB4AOACAMCAAH4A4AIAwIAAcgD/N6PMgABgAP93992AAWAA/yYjzIABYADgBgDAgAFgAOAGAMDABnAAgAYAwJP2PwCAAQDAATADAIABAMA="},{"view":2,"source":"field_01.jpeg","bits":"AAAAAOAAAMAAgAMA4AEAgACAPwDgAACAACU5AOAAAIDgADgA4AAAgMAAeADgAACAgAB4AOAEAICAAH4A4AUAgIAAcgD/TaaZgAFgAP/PrruAA2AA/00mmYADYADgDQCAgANgAOANAIDABXAAgA0AgJP0PwCAAwCAATADAIADAIA="},{"view":0,"source":"field_02.jpeg","bits":"AAD4AAAOAOAAgP0BAA4AwAHA/x8ADgDgAcCBHwAeAMABwIEfAB4AwAHAsR8APgDAAMABHwA+AMAB4AEf/P///wHgAR/8////AeCBP/j/A+AB4IE/ID8A8AHwgT8ADgDggef/PwAOAMCAB/4DAA4AwAAH8AEAHgDAAAAAAAAeAMA="},{"view":1,"source":"field_02.jpeg","bits":"AAD4AAAOAMAAAPwBAA4AwAHA/x8ADgDAAcCAHwAeAMABwAEfAB4AwAHAAR8AHgDAAMABHwA+AMABwAEf+P///gHgAR/8////AeCBP/j/A+AB4AE/ID4A8AHggT8ADgDggcf/PwAOAMAAB/wDAAwAwAAG8AEADgDAAAAAAAAeAMA="},{"view":2,"source":"field_02.jpeg","bits":"AADwAAAOAMAAAPwBAA4AwAHA/x8ADgDAAcCAHwAeAMABwAEfAB4AwAHAAR8AHgDAAMABHwA+AMABwAEf+P///gHgAR/8////AeCBP/h/AOAB4AE/AD4A8AHggT8ADgDggcf/PwAOAMAAB/wDAAwAwAAG8AEADgDAAAAAAAAeAMA="},{"view":0,"source":"field_04.jpeg","bits":"gP8PAMABAMCA/38AwAEAwIADfADAAQDQgAP4AMABAMCAA/gAwAMAwIAD+ADADwDAgAPwAPz/AMCAA/AA/v///4AD8AD/////gAPwAOCfAPDAB/AAwD8AwMIP+ADAAwDAn///AMADAMAH/D8AgAMAwAAAAACAAwDAAAAAAIADAIA="},{"view":1,"source":"field_04.jpeg","bits":"gP8PAMABAMCA/38AwAEAwIADcADAAQDAgANwAMABAMCAA/gAwAMAwIAD8ADADwDAgAPwAPy/AMCAA/AA/v///4AD8AD+////gAPwAOAfAPCAB/AAwD8AwIAH+ADAAwDAD///AMABAMAH+B8AgAEAwAAAAACAAwCAAAAAAIADAIA="},{"view":2,"source":"field_04.jpeg","bits":"gP8PAMABAMCA/38AwAEAwIADcADAAQDAgANwAMABAMCAA/gAwAMAwIAD8ADADwDAgAPwAPifAMCAA/AA/v///4AD8AD+////gAPwAOAfAPCAB/AAwD8AwIAH+ADAAwDAD///AMABAIAH+B8AgAEAwAAAAACAAwCAAAAAAIADAIA="},{"view":0,"source":"field_06.jpeg","bits":"AAA4AAAGAIAAAPwHAA4AgANA/g8AHgDAB8D//wAeAIAGwAN4AB4AgAfAA3gAHgCAA8ADeAA+AMADgAN4AD8AwAeAB3jg////BoAHeOD/tesGAAM4AD4AgA4AB3AAPgCABAC/fAA+AIACEPAPABwAgAMQ4AMAHACAAAAAAAAcAIA="},{"view":1,"source":"field_06.jpeg","bits":"AAAIAAAGAIAAAPwHAA4AgAMA/g8AHgDAB8D7fwAeAIAGwAN4AB4AgAfAA3gAHgCAA4ADeAA+AMADgAN4AD8AwAeAB3jA////BoAHeOD/teMGAAMwAD4AgA4AB3AAPgCABAAuNAA8AIACEPAPABwAgAMAYAMAHACAAAAAAAAYAIA="},{"view":2,"source":"field_06.jpeg","bits":"AAAAAAAGAIAAAPwHAA4AgAMA/g8AHgDAB8D7fgAeAIAGwAN4AB4AgAfAA3gAHgCAA4ADeAA+AMADgAN4AD8AgAeAB3jA/9//BoAHeOD/teMGAAMwAD4AgA4AB3AAPgCABAAuNAA8AIACEPAPABwAgAMAYAMAHACAAAAAAAAYAIA="},{"view":0,"source":"field_07.jpeg","bits":"AAAAAAAQAAAAAEABABAAAAAA8AcAMAAAAIDwEwAwAAABgAcRAHADAAAAAAAA4AsAAQAAAADwAwADAAEgAPCbAAMAAWAA+LtlAwAAYAD/++0DAANgAP/77wEAA2AA/r8PAQABYADgEgABAAN9AMAAAAGY/v8AwAAAABjYfwDAAAA="},{"view":1,"source":"field_07.jpeg","bits":"AADAAAAIAAAAAPgDABgAAAAA2AkAEAAAAIAAAACwAQAAAAAAAPABAAAAAAAA8AEAAQAAEADwDwABgAAQAPBPsAEAACAA/f+2AQAAMAD///cAgAAwAPlfAACAADAAYAMAAIABPgBgAgAAAO4/AGAAAAAM6B8AYAAAAAAgAwBgAAA="},{"view":2,"source":"field_07.jpeg","bits":"AADAAAAIAAAAAPgDABgAAAAA2AkAEAAAAIAAAACwAQAAAAAAAPABAAAAAAAA8AEAAQAAEADwDwABgAAQAPBPsAEAACAA/f+2AQAAMAD//3cAgAAwAPlfAACAADAAYAMAAIABPgBgAgAAAO4/AGAAAAAM6B8AYAAAAAAgAwBgAAA="},{"view":0,"source":"field_08.jpeg","bits":"AAAAAAAAAIAAAAAAAAAAgIABAACwAQCA/h8AgPkPAID+3wCA/38AgL//AIDP8wCAt/8A4IfzAIDB/wCAB3wA4MDfAOAH7AD+wN8AkAfgAP6A3wDgB+CA/wb4AOAP/gDi9/8A7r9/AOD4PwAOwH8AgPgHAALAfwCAAAAAALADAAA="},{"view":1,"source":"field_08.jpeg","bits":"AAAAAAAAAIAAAAAAAAAAgAAAAACAAACA/g8AgP0DAID/bQDA/z8AgMl/AMDjOwCAyX8AwAM4AIDwfwDAAzwA4PBvAMAD4AD8wG8AwAPgAP7AbwDAA+AA/gBsAPAD+wDi8H8A95MfAOD+HwAH4D8AgH4CAAHgHwCAAAAAAIADAAA="},{"view":2,"source":"field_08.jpeg","bits":"AAAAAAAAAIAAAAAAAAAAgAAAAACAAACA/g8AgP0DAID/bQDA/z8AgMl/AMDjOwCAyX8AwAM4AIDAfwDAAzwA4PBvAMAD4AD8wG8AwAPgAP7AbwDAA+AA/gBsAPAD+wDiwH8A95MfAOD+HwAH4D8AgH4CAAHgHwCAAAAAAIADAAA="},{"view":0,"source":"field_10.jpeg","bits":"YB8AAGA+AMDEfwAAZ/8AwMH8AYAH/AHAAOABgAf8AcDg/wGAB/wBwOB/AIAH+AH6wP8AgAfgAf8A+AGAH+AB/gDgAYAHwAH+AOADgAfAAcAA/AGCB/4BwP7/Ax7+/wHA/D8ABvg/AMAAAgAAAAAAgAAAAAAAAACAAAAAAAAAAIA="},{"view":1,"source":"field_10.jpeg","bits":"uA8AAAAWAMDgHwAAJv4AwEB8AMAH+AHAAPAAgAf4AcDAfwDAB/gBwKAfAIAH8AHgwD8AwAfwAf4A/ADAD+AB/gDwAMAH4AH8APABwAfgAcAA/gCDB/gBwP//AQf8/wGA/g8AA/gPAIAAAAAAAAAAgAAAAAAAAACAAAAAAAAAAIA="},{"view":2,"source":"field_10.jpeg","bits":"uA8AAAAsAIDgHwAATvwBgKF/AIDP/wOAAPABgA/gA4CA+AGAD/ADgMB/AIAP8AOAoB8AAA/gA4DAPwCAD+AD/MB/AIAP4AP8APABgB/AA/gA8AOAD8ADgADwA4APwAOAAP4BAg/wA4D//wEG/P8DAP+fAQbsPwAAugkAAkAXAAA="},{"view":0,"source":"new-white","bits":"AAAAAAAAgAEAAAAAAACAAQAAAAAAAIAB8B8A8H8A8AH8fwD8/wHwAf//ATzgB/ABPOABPIAH8AHA/wE8gAfwAcD/ATyAB/4HAP8B/IGH//8A4AH8gQf+BwDgAfyBB/AHAOAB/IEH8AcA4Af8gQfwAfz/x/P/B/AHDH/Aw/8B8Ac="},{"view":1,"source":"new-white","bits":"AAAAAAAAwAD8BwDgPwDAAPwHAOA/AMAAwx8A+P8AwAA8fgAe8APAAAB4AAbAA/AA8H8AHsAD8ADwfwAewAP+B/B/AB7AA/4HwH8AHsCD//8AeAB+wAP+BwB4AH7AA/AHAPgBfsAD8AD8f2D4/wPwAPx/YPj/A/AAABiAYfwA8Ac="},{"view":2,"source":"new-white","bits":"AAAAAAAAwAD8BwDgPwDAAPwHAOA/AMAAwx8A+P8AwAAMfgAe8APAAAB4AAbAA/AA8H8AHsAD8ADwfwAewAP+B/B/AB7AA/4HwH8AHsCD//8AeAAewAP+BwB4AH7AA/AAAPgBfsAD8AD8f2D4/wPwAPx/YPj/A/AAABiAYfwA8AA="},{"view":0,"source":"new-yellow","bits":"/z8AAAAAAAD/PwAAAAAAAP8/AAAAAAAA/z8AAP//AwD/PwAA//8DAP8/AAD//wMA////////////////////////////////////////AwD/////AAAAAP////8AAAAA/////wAAAAD/PwAAAAAAAP8/AAAAAAAA/z8AAAAAAAA="},{"view":1,"source":"new-yellow","bits":"//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAOD/////BwAA4P////8HAADg/////wcAAOD/////BwAA4P//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAA="},{"view":2,"source":"new-yellow","bits":"//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAOD/////BwAA4P////8HAADg/////wcAAOD/////BwAA4P//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAA="},{"view":0,"source":"r3-green","bits":"fwCA/wDgAQBsAMD/AOABAOAD8P8f4AMA/APAwR/gAwDwA/DBHvgDAPwD8MEe+AMA4ADwBx7+AwCAA4DBHv7//4ADgMEe/v//AAOAwR7+//8AA4DBBvgDAAADgMEG+AMADACA/wf4AwCAAAAAAYADAAAAAAAAgAMAAAAAAACAAwA="},{"view":1,"source":"r3-green","bits":"HwCA/wAAAAAAAED+AIABAIAAwP8fgAMADAPAwR6AAwAAA8DBHoADAOAA8AEGeAIAgADAAR7+AwAAA4ABGOD//wADgAEY4P//AAOAARj+//8AA4DBAPgDAAAAgMEA+AMAAACA/wB4AgAAAAAAAQACAAAAAAAAAAIAAAAAAAAAAgA="},{"view":2,"source":"r3-green","bits":"HwCA/wAAAAAAAED+AIABAIAAwP8fgAMADAPAwR6AAwAAA0DAHoADAOAA8AEGeAIAgADAAR7+AwAAA4ABGOD//wADgAEY4P//AAOAAQD+//8AA4DBAPgDAAAAgMEA+AMAAACA/wB4AgAAAAAAAQACAAAAAAAAAAIAAAAAAAAAAgA="},{"view":0,"source":"r3-red","bits":"AAAAAwAAAAAAAABwADAAAAAAAHAAMAAAAAAAcAAwAAAAAOB/AP4AAAYA+P8A/gAABwD4/wD+AMBgAP78gP8D8FgAfvCA/wP4QQAe8AD+P/tAAH7wAP4/+0AAHvAA/gPwQAB4/ADwA/AGABj/APADABgAAHwA8AMAGAAAEADwAwA="},{"view":1,"source":"r3-red","bits":"AAAABAAAAAAAAAAcABgAAAAAABwAGAAAAAD4BwB5AAAAAH4fAHkAAAAAfn8AfwAAAAB+ZAD/ATATAB5kwP8B8BAABmQA/wMwEAAGZAD/AzAQAAZkAP8z+RAABmQA+QHwAAAeYAD4ATAAAIBnAGAAAAAAABwAYAAAAwAABADgAQA="},{"view":2,"source":"r3-red","bits":"AAAABAAAAAAAAAAcABgAAAAAABwAGAAAAAD4BwB5AAAAAH4fAHkAAAAAfn8AfwAAAAB+ZAD/ATATAB5kwP8B8BAABmQA/wMwEAAGZAD/AzAQAAZkAP8z+RAABmQA+QHwAAAeYAD4ATAAAIBnAGAAAAAAABwAYAAAAwAABADgAQA="},{"view":0,"source":"r3-yellow","bits":"AAAAAAAAAODAPwAAwH8AAMA/AADAfwAAAP4BgP//AQAA+A/A//8P4AD4D8D//w/gwP8PwP//D+DA/w/AP/4P/MD/D8A/8I//APh/wD/+j/8A+H/AP/4P4P//j////w/g//+B////AeD4PwA8/H8A4Pg/ADz8fwDgAAAAAAAAAOA="},{"view":1,"source":"r3-yellow","bits":"AD4AAMB/AAAAPgAAwH8AAAD+AYD//wEAAP4BwP//D+AA+A/A//8P4AD+D8A//g/gAP4PwD/+D+DA/w9APPAP/MD/D8A/8I//AMAPwD/+j/8AwA/AP/6P/wD4f8A/8A/g+P+P////D+AH/oHD//8B4Pg/AAD8fwDg+D8AAPx/AOA="},{"view":2,"source":"r3-yellow","bits":"AD4AAMB/AAAAPgAAwH8AAAD+AQD8/wEAAP4BwP//D+AA+A/A//8P4AD+D8A/8A/gAP4PwD/wD+DA/w9APPAP/MD/D8A/8I//AMAPwD/+j/8AwA/AP/6P/wD4D8A/8A/g+P8P/P//D+AH/oGD//8B4Pg/AAD8fwDg+D8AAPx/AOA="},{"view":0,"source":"r3-white","bits":"AAAAAA8AAAAAAAAAPwAAAAAAAAA/AAAAAPgDAD8AgAEAngMAPwCAGQCeA8A/AIAfDP4D4D8AgB8P/gPgPwCAH4z5A/j/AID/jPkD4P////8M/oP5///zfwz+A+A/A8AfDPgD4D8AgB/8nwPADwAAGADgAwAPAAAYAGAAAD8AABg="},{"view":1,"source":"r3-white","bits":"AAAAgAcAAAAAAACABwAAAAAAAIAfAAAAAMAAgB8AAAAADACAHwAAAIDPAIAfAAAYAMwA4B8AAB4AwADgHwDAH2PAAPAfAMB/Y8AA4P8H/v8D/GD8/xvgf4P/APCfA+AfA/wAcB4AwBnkDwAABgAAGAAwAAAGAAAAAAAAAAYAAAA="},{"view":2,"source":"r3-white","bits":"AAAAgAcAAAAAAACABwAAAAAAAIAfAAAAAMAAgB8AAAAADACAHwAAAIDPAIAfAAAYAMwA4B8AAB4AwADgHwDAHwPAAPAfAMAfA8AA4P8H/v8D/GD8/xvgf4P/APCfA8AfA/wAcB4AwBnkDwAABgAAGAAwAAAGAAAAAAAAAAYAAAA="},{"view":0,"source":"r4-green-compact","bits":"AAAAAAAYAIAfAPg/ADgAgBkA+D8AOACAfgD4/wP+AIB/AHjwA/4AgH4AeDAD/gCAeABgMAP/AIBgAGAwA////3gAYPAz/v//YADg8MP///94AGDwAP4AgBgAYPAA/gCAGADg/wD+AIAAAADAAPgAgAAAAAAA+ACAAAAAAADgAIA="},{"view":1,"source":"r4-green-compact","bits":"BwDgPwAgAIAYAJg/ACAAgBgA+P8A+ACAfwB4MAPeAIB+AHgwA94AgB4AeAAD3gCAAABgAAD/AIBgAGAAA////wAAYDAD+P//AABg8MP///8AAGDwAP4AgAAAYDAA/gCAAACAwwDYAIAAAADAANgAAAAAAAAAwAAAAAAAAADAAAA="},{"view":2,"source":"r4-green-compact","bits":"BwDgPwAgAIAYAJg/ACAAgBgA+P8A+ACAfwB4MAPeAIB+ABgwA94AgB4AeAAA3gCAAABgAAD/AIAAAGAAAP///wAAYDAD+P//AABg8MP///8AAGDwAP4AgAAAYDAA/gCAAACAwwDYAIAAAADAANgAAAAAAAAAwAAAAAAAAADAAAA="},{"view":0,"source":"r6-blue","bits":"AAAAAAAABgD+AQD8B8AfAPAHgP8fwB8A/j/w///AHwDAP/D//8AfAP4/8Of/wB8A/j/wB//+f3z+P/Dn//7//8B/8Of//v//zn/w///Af4D/v////8B/AP4BAPwHwBkAAAAAAAAAGAAAAAAAAAAYAAAAAAAAABgAAAAAAAAAGAA="},{"view":1,"source":"r6-blue","bits":"AAAAAAAABwAAAAD+A8AIAAADwP8fwA8A/Bzw/3/ADwDgHDD+f8APAP8fMIJ/wA8A/x8wgn/+f3z/H/Djf/7//wA/8IN//v//4D8w4n/AfwD/3///f8B/APzDwf8fwA8AHAAA/APACAAAAAAAAAAIAAAAAAAAAAgAAAAAAAAACAA="},{"view":2,"source":"r6-blue","bits":"AAAAAAAABwAAAAD8A8AIAAADwP8fwA8A/Bzw/3/ADwDgHDD+f8APAP8fMIJ/wA8A/x8wgn/4f3D8H/CDf/7//wAf8IN//v//AB8w4n/AfwD/3///f8APAPzDAf4fwA8AHAAA/APACAAAAAAAAAAIAAAAAAAAAAgAAAAAAAAACAA="},{"view":0,"source":"r7-green-compact","bits":"AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAPjwPwAA/g8A+PA/AAD+DwD4/D8AAP4fAPj8/wAA/h8A+Pz/AAD+HwD4//8BwP8/APge6AHgD/AA+B7oAeAP8AD4HPgD4B/8APg="},{"view":1,"source":"r7-green-compact","bits":"AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAHjwPwAA/g8A+PA/AAD+DwD4/D8AAP4fAPj8/wAA/h8A+Pz/AAD+HwD48/8BwP8/APgc6AHgD/AA+BzoAeAP8AD4DPgBwA/8APg="},{"view":2,"source":"r7-green-compact","bits":"AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAHgAAAAAAAAAeAAAAAAAAAB4AAAAAAAAAHjwPwAA/g8A+PA/AAD+DwD4/D8AAP4fAPj8/wAA/h8A+Pz/AAD+HwD48/8BwP8/APgc6AHgD/AA+BzoAeAP8AD4DPABwA/wAPg="},{"view":0,"source":"r7-red-compact","bits":"AAAAAAAIAIAAAAAAABwAgAAA8AcAHAAAAAD4DwAcAIAPAP4/ABwAgAwAH34APgCADgAffABeAIAPAA98AN4BwAeAn3wA/gHAD4APfOD/7/+MgA98wP///xwAD3hAvAPgHAAPYAD8AMAMAL8zAPwAgB8Q/h8AfACAAwDABwD8AAA="},{"view":1,"source":"r7-red-compact","bits":"AAAAAAAIAAAAAAAAAAwAAAAA8AcAHAAAAADwDwAcAIAPAPw/ABwAgAwAHn4APACADgAPeABcAIAPAAd4AN4AwAcAj3wA/gDAD4APfOD/5/8MAA98wP/H+xwAD3AAvAHAHAAPYAD8AIAMAD8xAHwAgA8AzB8APACAAwDABwD8AAA="},{"view":2,"source":"r7-red-compact","bits":"AAAAAAAIAAAAAAAAAAwAAAAA8AcAHAAAAADwDwAcAIAPAPw/ABwAgAwAHn4APACADgAPeABcAIAPAAd4AN4AgAMAj3wA/gDAD4APfOD/5/8MAA98wP/H+xwAD3AAvAHAHAAPYAD8AIAMAD8xAHwAgA8AzB8APACAAwDABwD8AAA="},{"view":0,"source":"r7-orange-compact","bits":"BgADAHAAAIAGAAcAcAAAgAYABwB4AACABgAHAP4AAIAGAAfA/wAAgAcAB+D/D+D/BwAHwP8f4P8HAAcA/AEAgEYABwDgAAAAbgAHAOABAAD8ZwMA4AEAAPB/AADgAQAA4HkAAOABAAAAAAAA4AAAAAAAAADAAAAAAAAAAMAAAAA="},{"view":1,"source":"r7-orange-compact","bits":"BgADAGAAAAAGAAcAcAAAgAYABwB4AAAABgAHAH4AAAAGAAfA/wAAgAMAB8D/D8D/AwAHwP8fwP8GAAcA8AAAgEYABwDgAAAATAAHAOABAAD8QAMA4AAAAOB/AADgAAAA4DEAAOAAAAAAAAAA4AAAAAAAAADAAAAAAAAAAMAAAAA="},{"view":2,"source":"r7-orange-compact","bits":"BgADAGAAAAAGAAcAcAAAgAYABwB4AAAABgAHAH4AAAAGAAfA/wAAgAMAB8D/D8D/AwAHwP8fwP8GAAcA8AAAgEYABwDgAAAATAAHAOABAAD8AAMA4AAAAOB/AADgAAAA4DEAAOAAAAAAAAAA4AAAAAAAAADAAAAAAAAAAMAAAAA="},{"view":0,"source":"legacy-white-current","bits":"AAAAAADAAMAAAAAAAMAAwAAAAAAAwADA+AOA/wDwAAD+D8D/A/AAAP8/wIEP8AAAHjzAAQ/wAMDgP8ABD/AAwOA/wAEP/gPAwD/ABw////8APMAHD/4DwAA8wAcP8APAADzABw/wA8AAfMAHD/AAwP5/vP8P8APAxg88/gPwAwA="},{"view":1,"source":"legacy-white-current","bits":"AAAAAADAAAD8AQD+AMAAAPwBAP4AwAAAwweA/wPAAAC8H+DBD8AAAAAeYAAP8AAA8B/gAQ/wAMDwH+ABD/4BwPAf4AEP/gHAwB/gAY////8AHuAHD/4BwAAe4AcP8AHAAH7gBw/wAMD8H4b/D/AAAPwfhv8P8AAAAAYY9gPwAQA="},{"view":2,"source":"legacy-white-current","bits":"AAAAAADAAAD8AQD+AMAAAPwBAP4AwAAAwweA/wPAAACMH+DBD8AAAAAeYAAP8AAA8B/gAQ/wAMDwH+ABD/4BwPAf4AEP/gHAwB/gAY////8AHuABD/4BwAAe4AcP8ADAAH7gBw/wAAD8H4b/D/AAAPwfhv8P8AAAAAYY9gPwAAA="},{"view":0,"source":"legacy-yellow-shift2","bits":"/z8AAAAAAAD/PwAAAAAAAP8/AAAAAAAA/z8AAP//AwD/PwAA//8DAP8/AAD//wMA////////////////////////////////////////AwD/////AAAAAP////8AAAAA/////wAAAAD/PwAAAAAAAP8/AAAAAAAA/z8AAAAAAAA="},{"view":1,"source":"legacy-yellow-shift2","bits":"//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAOD/////BwAA4P////8HAADg/////wcAAOD/////BwAA4P//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAA="},{"view":2,"source":"legacy-yellow-shift2","bits":"//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAOD/////BwAA4P////8HAADg/////wcAAOD/////BwAA4P//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAA="}],"2.0":[{"view":0,"source":"field_01.jpeg","bits":"AAAAAOADAAAAAAAA4AMAAAD4AwDgBwAA4P8/AMATAADgJz8AwBMAAOAAPgDgEwAA4AA4AOAXAADwAHwA8BcAAPAEfgDwlwAA4AF4gP+/2c3AAHqA/7/f3eAAcoD/twDM4AH8AOAXAEDAQfwAwBcAAMjvfwAAFwAAw/8vAAAPAAA="},{"view":1,"source":"field_01.jpeg","bits":"AAAAAMADAAAAAAAAwAMAAAD4AwDgBwAAwPwfAMADAACAJz8AwAMAAMAAPgDgEwAAwAA4AOAXAADgAHgA4BMAAPAAeADwFwAA4AF4AP6/2c0AAGIA/r/f3eAAcoD/twDMwAFwAOAXAADAQfwAwBcAAIDvfwAAFwAAgf8vAAAPAAA="},{"view":2,"source":"field_01.jpeg","bits":"AAAAAMADAAAAAAAAwAMAAAD4BwDgBwAAwPw/AMADAACAJ34AwAMAAMAAfADgEwAAwABwAOATAADgAPAA4BMAAPAA8ADwFwAA4AHwAP6/s5sAAMQA/r+7m+AA5AD/twGYwAHgAOAXAADAQfgBwBcAAIDv/wAABwAAgf9fAAAHAAA="},{"view":0,"source":"field_02.jpeg","bits":"AAAAAAA8AIABAPwPADwAAAMA/h8APAAAD4DffwA8AAAOgA9+AHwAAAaAD3wA/AAABoAP+AD8AQAGgA/4AP8DwAeAB/jg////AQAH/PD///8BAA78QP4DwA8ADvwA/ADADwD+/wD8AIAPIP5/ADwAAA8A+D8AeAAAAAgAAAD4AQA="},{"view":1,"source":"field_02.jpeg","bits":"AAAAAAA8AIABAPwPADwAAAMA/h8APAAAD4DPfwA8AAAOgA9+ADwAAASAD3gAfAAABoAPeAD8AQAGgA/4AP8DgAcAB/DA////AAAG/PD///8BAA78APwBwA8ADvwA/ADADwD+/wB8AIAPAP5/ADgAAA8A+C8AeAAAAAAAAAB4AQA="},{"view":2,"source":"field_02.jpeg","bits":"AAAAAAA8AIABAPwPADwAAAEA/h8APAAAD4CPfwA8AAAOgA9+ADwAAASAD3gAfAAABoAPeAD8AQAGgA/4AP8BgAcAB/DA////AAAG/PD///8AAA78APwBwA8ADvwA/ACADwD+/wB8AAAPAP5/ADgAAA8A+A8AeAAAAAAAAAB4AAA="},{"view":0,"source":"field_04.jpeg","bits":"AAD/BwA8AAAAwP8PADwAAAHA/z8APAAAAcBhPwA8AAABwAE/AD4AAAPAAT8APAAAA8ABPwD+AQADwAE/gP///wDAAz/A////AMADPsD/D5gB4AM4AH4DAAPACzoAfAEAF4f/PwB8AAAHBvwPADwAAAcE+AcAfAAAAAAAAAD4AAA="},{"view":1,"source":"field_04.jpeg","bits":"AAD/BwA8AAAAwP8PADwAAAHA/z8APAAAAcBhPwA8AAABwAE/ADwAAAPAAT8APAAAA8ABPwD+AQADwAE/gP///wDAAz+A////AMADPsD/D5ABwAM4AH4DAAPACzgAfAAAB4b/PwB8AAAHBvgPADwAAAcE+AcAfAAAAAAAAAD4AAA="},{"view":2,"source":"field_04.jpeg","bits":"AAD/BwA8AAAAwP8PADwAAAHA/z8APAAAAcBBPwA8AAABwAE+ADwAAAPAAT8APAAAA8ABPwD+AQADwAE/gP///wDAAz+A////AMADPsD/D4AAwAM4AH4DAAPACzgAfAAAA4b/PwB8AAAHBvgPADwAAAcE+AcAfAAAAAAAAAD4AAA="},{"view":0,"source":"field_06.jpeg","bits":"AAAAAADgAAADAOA/APAAAA8A4H8A8AAAHwD4/wP4AAAYADzAA/gBADAAPMAD+AEAeAB8gAH4AQD8AHyAAf4BAH4AfIAD/v//HwB8gAP+//YDAHyAA/gBADMAfIAD+AEA/wD4/QHwAQD/QOD/AfADAP9AgH8A4AEAfwAAAADgAQA="},{"view":1,"source":"field_06.jpeg","bits":"AAAAAADgAAADAMA/APAAAAcAoH8A8AAAHwDw/wH4AAAYADjAA/gBADAAPMAB+AEAeAB8gAH4AQB4AHyAAf4BAH4AfIAD/h//HgB8gAP+b+YDAHyAAfgBADMAeIAD+AEA/wD48QDwAQD/QGDfAPADAP8AAD8A4AEAfwAAAADgAQA="},{"view":2,"source":"field_06.jpeg","bits":"AAAAAADgAAADAMA/APAAAAcAoH8A8AAAHwDw/wH4AAAYADjAA/gBADAAPMAB+AEAeAB8gAH4AQB4AHyAAf4BAH4AfIAD/h//HgB8gAP+beYDAHyAAfgBADMAeIAD+AEA/wD48QDwAQD/QGDfAPADAP8AAD8A4AEAfwAAAADgAQA="},{"view":0,"source":"field_07.jpeg","bits":"AgCA/AAAJAAHAID+AAAkAC8AgP8HAAAAIwDAAQcABAAAAAAABABkAAAAAAAAAGwAAABAAAAAfpIgAEAAAPD/ljgAQAAA8P++BwBAAADw/7YHAEAAADBfAGAAQAAIAMwA4QBBBggAzABDgAn3DQCIAP+AAN4DAIgA/wAA0AAAiAA="},{"view":1,"source":"field_07.jpeg","bits":"AAAAZgAAEAADAAB/AAAAABcAALcBAAAAAQDgAAMAAAAAAAAAAAAgAAAAAAAAADQAAAAgAAAAPAkAACAAAPA/yxwAIAAA+H/bAAAgAAB4fwMCACAAABguACAAIAAEAGQAQABgAwQARAAhwAD7BgAEAHcAAMwAAAAAfwAASAAARAA="},{"view":2,"source":"field_07.jpeg","bits":"AAAAZgAAEAADAAB/AAAAABcAALcBAAAAAQDgAAMAAAAAAAAAAAAgAAAAAAAAADQAAAAgAAAAPAkAACAAANA/yxwAIAAA+H/bAAAgAAB4fwMCACAAABguACAAIAAEAGQAQABgAwQARAAhwADzBgAEAHcAAMwAAAAAfwAASAAARAA="},{"view":0,"source":"field_08.jpeg","bits":"//gPAAAAAAD/PgcAAAAAAP8/AgAAAAAA/78DWAIANwD//wPcC4D/Ab//AzwOgOQAOpYAAAzAwAAHFgAAHoDgAD8+AIAfgOAA/x8AgBOAwID/HwD4GsDkgH4/APgf1u4AeBwA/B+GfwD+PwDoAAACAP89AAAAAAAA/z0AAAAAAAA="},{"view":1,"source":"field_08.jpeg","bits":"//gPAAAAAAD/OAIAAAAAAP8/AgAAAAAA+z8DUAAANwD/vwNQA4DvAL7/AzQGgOQAOpYAAAzAwAAHFgAAHoDgAD8+AIAfgOAA/x8AgBOAwID/HwD4GoBkgH4fAPgf1m4AeBwA/B+GfwD+PwDoAAAAAP89AAAAAAAA/z0AAAAAAAA="},{"view":2,"source":"field_08.jpeg","bits":"//gPAAAAAAD/OAIAAAAAAP8eAgAAAAAA+z8DUAAANwD/vwNQA4DvAL7/AzQGgMQAOpYAAAzAwAAHFgAAHoDgAD8+AIAegOAA/x8AgBOAwID/HwD4GIBkgH4fAPgf1m4AeBwA/B+GfwD+PwDIAAAAAP49AAAAAAAA/z0AAAAAAAA="},{"view":0,"source":"field_10.jpeg","bits":"HgD/AQD+A4AfgP8HAP8PgB+A/wcA/g+ABwCBD4ADHoACwAEOgAMcgAAAAA6AAxzAAAAADsADHMAAAMAPwAMO+AAAwA+AAx74AADwCYADHPgAAHwDgAMcgAAA/A/AAx6AAAD/D4ADDoAAgP8PiP8PAADA/w8M/wMAAMDvDQDYAgA="},{"view":1,"source":"field_10.jpeg","bits":"HgD/AQD4AYAfAP8HAPoPgB8A/wcA/g8ABwCBD4ADHgACgAAMgAMcAAAAAAyAAxzAAAAADIADHMAAAIAPwAMM+AAAgA+AAxz4AADwAYADHOAAAHADgAMcgAAA/A+AAxyAAAD/D4ADDoAAgP8PAP8HAACA/w8I/gMAAIDtDQBQAgA="},{"view":2,"source":"field_10.jpeg","bits":"PAD+AwDwAwA+AP4PAPYfAD8A/g8A/h8ADwACHwAHPAAFAAEYAAc8AAAAABgABzyAAAAAGAAHPIAAAIAfgAcc+AAAgB8ABzzwAADgAwAHPMAAAGAGAAc8AAAA+B4ABzwAAAD+HwAHHAAAAP8fAP4PAAAA/x8Q/gcAAABbGwCgAAA="},{"view":0,"source":"new-white","bits":"fwAAAAAAABt8AAAAAAAAG3wAAAAAAAAbfAB/AIA/ABh8wP8B+P8AHH/g/wP4/wMcH+CDA3jwAxwAAIADeMADHAAAgAN48AMfAADAA3jw4/8AAPwB+MEDfwAA/wP4wQMcAMD/D+H/AxwAwP8Phv8AHADA/wMG/gAcAAAAAAAAABw="},{"view":1,"source":"new-white","bits":"fAAAAAAAABh8AAAAAAAAGHwAAAAAAAAYcAB/AIA/ABh8wP8B+P8AGH/g/wP4/wMcHwCDA3jwAxwAAIADeMADHAAAgAN4wAMfAADAA3jw4/8AAPwB+MEDfwAA/wP4wQMcAMD/D+D/AxwAwP8PgP8AHADA/wMA/gAEAAAAAAAAABw="},{"view":2,"source":"new-white","bits":"fAAAAAAAABh8AAAAAAAAGHwAAAAAAAAYcAA/AIA/ABhwwP8B4P8AGH/g/wP4/wMcHwCDA3jwAxwAAIADeMADHAAAgAN4wAMfAADAA3jA4/8AAPwBeMADfwAA/wP4wQMcAMD/D+D/AxwAwP8PgP8AHADA/wMA/gAEAAAAAAAAABw="},{"view":0,"source":"new-yellow","bits":"AAAAAAAAABgAAAAAAAAAGAAAAAAAAMB/AAAAAAAAwH8AAAAAAADA/wAAAAAAAMD/AAAAAAAA8P8AAAAAAADw/3AAAABwAMB/cAAAAHAAwH//AQAAcAAAf/8BAABwAAB//wEAAHwAAAD/AQAAfAAAAP8BAAAAAAAA/wEAAAAAAAA="},{"view":1,"source":"new-yellow","bits":"AAAAAAAAgP8AAAAAAACA/wAAAAAAAAD+AAAAAAAAAP4AAAAAAAAA/gAAAAAAAID/AAAAAAAAgP8AAAAAAACA/wAAAAAAAID//wEAAAAAAAD/AQAAAAAAAP8BAAAAAAAA/wEAAAAAAAD/AQAAAAAAAA8AAAAAAAAADwAAAAAAAAA="},{"view":2,"source":"new-yellow","bits":"AAAAAAAAgP8AAAAAAACA/wAAAAAAAAD+AAAAAAAAAP4AAAAAAAAA/gAAAAAAAID/AAAAAAAAgP8AAAAAAACA/wAAAAAAAID//wEAAAAAAAD/AQAAAAAAAP8BAAAAAAAA/wEAAAAAAAD/AQAAAAAAAA8AAAAAAAAADwAAAAAAAAA="},{"view":0,"source":"r3-green","bits":"AAAAAAAABAAAAAAAAAAEAPwDAAYAAAQAEACABxiABQAAPwAG/uEHAAA/AAZm4AcAgD8AHmbgHwCAPwAeZvh/sIA/gB9m+H/A8AOAH2b4f/DwAwAYBuAfAP8/ABgGgB8A/z8A+AeAHwD/P4AHeIAfAP8/AAAYgB8A/z8AwAGAHwA="},{"view":1,"source":"r3-green","bits":"AAAAAAAABAAAAAAAAAAEAPADAAAAAAQAAAAABhgABAAAMwAGZoAHAAA/AAZm4AcAgD8ABmbgHwCAPwAeZvh/AAA/AB5g4H/A4AMAGADgf8CQAwAYBuAfAPw/AAAGgB8A/z8A+AeAHwD8P4AHGIAfAPw/AAAAgB8A/z8AAAAAHgA="},{"view":2,"source":"r3-green","bits":"AAAAAAAABAAAAAAAAAAEAPADAAAAAAQAAAAABhgABAAAMwAGZoAHAAA/AAZmgAcAAD8ABmbgBwCAPwAeZvh/AAA/AB5g4H/A4AMAGADgf8CQAwAYBuAfAPw/AAAGgB8A/z8A+AeAHwD8PwAGGIAfAPw/AAAAgB8A/z8AAAAAHgA="},{"view":0,"source":"r3-red","bits":"AAAAAADAAwAAAAAAAPwDAAAAAB8A8AMAAAAAfwDwAwAAAAD/APADAAEA4H8A8AMAAAZgcADwA8AAAOBwAPwPwKABYAAD/P/44AHgAAPw//9AAODgA/D//2AA5vwD/P/7/wGG8AP8D8C/AYb/A8ADwP8BAPwD8APA/wEA/ADwAwA="},{"view":1,"source":"r3-red","bits":"AAAAAADAAAAAAAAAAMADAAAAAA8AwAMAAAAAHwDAAwAAAABsAMADAAEAgH8AwAMAAAAAcADAA8AAAIBwAPADwAAAYAAD8P/4wAHgAAPwP/xAAOAAA/D//2AAgPAD/D/4+QGA8APAA8A/AIB/AAADwD8AAJAAAAMAnwEAAAAAAwA="},{"view":2,"source":"r3-red","bits":"AAAAAADAAAAAAAAAAMADAAAAAA8AwAMAAAAAHwDAAwAAAABsAMADAAEAgH8AwAMAAAAAcADAA8AAAABwAPADwAAAYAAD8P/4wAFgAAPwP/xAAOAAA/D//yAAgPAD/D/w+QGA8APAA8A/AIB/AAADwD8AAJAAAAMAnwEAAAAAAwA="},{"view":0,"source":"r3-yellow","bits":"//8fAAAAAMD//x8AAAAAAPz/H/gHwD8A//8f/h/w/wD//w/+H8D/AP/+Axge8PDADAAAAB7A8PD8PwAAH8Dw/Pw/AOAH8PD8/D8A+B/w0MD8PwD+H/gfwP8PAPgfwA/A/z8AAAAAAAD/PwAAAAAAwP8/AAAAAAAA/D8AAAAAAAA="},{"view":1,"source":"r3-yellow","bits":"//8fAAAAAMD8/x8AAAAAAPw/H/gHwB8A/P8f/h/A/wD8/w/+H8D/APz+AxgewPDADAAAAB7A8PDwPwAAH8DwzPA/AOAHwNDM8D8A+B/A0MD8PwD+H/gfwP8PAPgfwA/A/z8AAAAAAAD/PwAAAAAAAP8/AAAAAAAA/D8AAAAAAAA="},{"view":2,"source":"r3-yellow","bits":"//8fAAAAAMD8/x8AAAAAAPw/H/gHwB8A/P8f/h/A/wD8/w/+H8D/APz+AwAewPDADAAAAB7A8PAwPwAAH8DwzPA/AOAHwNDM8D8A+B/A0MD8PwD+H/gfwP8PAPgfwA/A/z8AAAAAAAD/PwAAAAAAAP8/AAAAAAAA/D8AAAAAAAA="},{"view":0,"source":"r3-white","bits":"AAAAAGAAAHgAAAAA4AEAeAD+AQDgAQB4AP4HAOABAHgAfg4A4AEAeID/NwDgBwB4gIEHAOAHAHiAgTcA/gcAeICBNwD+BwB4gOE3sP////+AgTeA/////4CBP8D/////gAE+AP4HQP6MYT4A/gcA+Lz/DwD+AQD4/58/AOAHAPg="},{"view":1,"source":"r3-white","bits":"AAAAAGAAAHgAAAAA4AEAeAD+AQDgAQB4AGAAAOABAHgAYAgA4AEAeID/NwDgAQB4gIEHAOABAHiAgTcA/gcAeIABNgD+BwB4gAE2gP////+AgQcA+P///4CBB4D/////gAEGAP4HQP6MAQ4A/gcA+Lz/DwD4AQD484E5AIABAPg="},{"view":2,"source":"r3-white","bits":"AAAAAGAAAHgAAAAAYAAAeAD+AQDgAQB4AGAAAOABAHgAYAgA4AEAeID/NwDgAQB4gIEHAOABAHiAgTcA/gcAeIABNgD+BwB4gAE2gP////+AgQcA+P///4CBB4D//0/+gAEGAP4HQP6MAQ4A/gcA+Lz/DwD4AQD484E5AIABAPg="},{"view":0,"source":"r4-green-compact","bits":"AAAAAAAAAwAAAAAAAAADAH8AgAAAAAMAeACAAAPgAwB/AID/P/gDAGAGgAA/+AMA4AeAAA/4AwDgB4ADD/gDAOAHgAMP/n/g4AeAAw/4//9+AIADDP7///8H+AMM4AcA/wdg/zzgBwD/B+AAD+AHAP8HAAAD4AcA/wcA8ADgBwA="},{"view":1,"source":"r4-green-compact","bits":"AAAAAAAAAwAAAAAAAAADAH4AAAAAAAMAYACAAAMgAwB+AAD/DOADAGAGAAA8+AMAYAYAAAz4AwDgBwAADPgDAGAGAAMM+H/g4AeAAwz4f/h4AAADDPh/4P8HAAMA4AcAfwYA/wDgBwD/B2AAD+AHAP8HAAAAwAQA/wcAAADABAA="},{"view":2,"source":"r4-green-compact","bits":"AAAAAAAAAwAAAAAAAAADAH4AAAAAAAMAYACAAAAgAwB+AAD/DOADAGAGAAAM+AMAYAYAAAz4AwDgBwAADPgDAGAGAAMM+H+A4AeAAwz4f/h4AAADDPh/4P8HAAMA4AcAfwYA/wDgBwD/BwAAD+AHAP8HAAAAwAQA/wcAAADABAA="},{"view":0,"source":"r6-blue","bits":"/z8AAAAAmAD/PwAAAACYAP8/QAAAAJgA/z/+H/h/mAD/D/4fOH/4AP0HAB44fvgAEACAHzh+/AN/AMAfOH7//38A8Ac4Zv//fwD4Hzh++Ad/AP4f+H/4Ax8A/t/gH/gAHwD4H+AH+AB/AAAAAAD4AH8AAAAAAPgAfwAAAAAA+AA="},{"view":1,"source":"r6-blue","bits":"/z8AAAAAgAD/PwAAAACAAP8/QAAAAJgA/z/2H/h/mAD/D/4fOGeYAP0BAB44ZvgAEACAHzhm/AN/AIAfOGb4/38A8Ac4Zvz/fwD4Hzhm+Ad/AP4f+Gf4Ax8A/h/gH5gAHwD4H+AHmAB/AAAAAACAAH8AAAAAAJgAfwAAAAAAmAA="},{"view":2,"source":"r6-blue","bits":"/z8AAAAAgAD/PwAAAACAAP8/AAAAAJgA/z/2H/h/mAD/D/4fOGaYAP0BAB44ZvgAEACAHzhm/AN/AIAfOGb4/38A8Ac4Zvz/fwD4Hzhm+AN/AP4f+Gf4AB8A/h/gH5gAHwD4H+AHmAB/AAAAAACAAH8AAAAAAJgAfwAAAAAAmAA="},{"view":0,"source":"r7-green-compact","bits":"AAAAAAAAAPwAAAAAAAAA+AAAAAAAAAD8AAAAAAAAAPwAAAAAAAAA/AAAAAAAAAD8AAAAAAAAAPwAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+P8AAAD/DwD8/wEA4P8/APz+AQD4B34A/PwBAPgBPgD88AEA8Ad+APw="},{"view":1,"source":"r7-green-compact","bits":"AAAAAAAAAPwAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPwAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+D4AAADoDwD4/wAA4P8/APz8AQD4AT4A/PwBAPgBPgD88AEA8AA+APw="},{"view":2,"source":"r7-green-compact","bits":"AAAAAAAAAPgAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+AAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA+D4AAADoDwD4/wAA4P8/APz8AQD4AT4A/PABAPgBPgD88AEA8AA+APw="},{"view":0,"source":"r7-red-compact","bits":"AAAAAADwAwAAAAAAAPADAA8AgH8A8AMAHwDg/wDwAwAzAPD/APADAGAAOPAB8AMAIAA88AHwAwAwADzgAfALADAAOOAB/N/kMAA44AH8//8OADjgA/7/9wMAOMAB+A8AZwA44APgAQB/QPj/A+ADAD9A8P8A4AcAP0DAfwDwAwA="},{"view":1,"source":"r7-red-compact","bits":"AAAAAADwAwAAAAAAAPADAA8AgD8A8AMAHwCg/wDgAwAzAPD/APADAGAAOPAB8AMAIAA44AHwAwAgADjgAfALADAAOMAB/B/kMAA44AH8//8OADjgAf7/9wMAOMAB8AcAZwA4wAHgAQB/QPD/AeADAD8A4P8A4AEAP0CAfwDgAQA="},{"view":2,"source":"r7-red-compact","bits":"AAAAAADwAwAAAAAAAPADAA8AgD8A8AMADwCg/wDgAwAzAPD/APADAGAAOPAB8AMAIAA44AHwAwAgADjgAfADADAAOMAB/B/kMAA44AH8//8OADjgAf7/9wMAOMAB8AMAZwA4wAHgAQB/QPD9AeADAD8A4P8A4AEAP0CAfwDgAQA="},{"view":0,"source":"r7-orange-compact","bits":"APBAAIADAAAAwEAAgAMAAIAAQADAAwAAgAhAAIADAACASUAA4AMAAIBtQAD8BwCAgB1AAP7/v++AHUAA/r//3oABAAD+AwMAAAEAAKADAAAAAYAAAAMAAAAfAAAAAwAAgeAPAAADAAAB+A4AAAMAAAAcCAAAAwAAAAAAAAADAAA="},{"view":1,"source":"r7-orange-compact","bits":"AAAAAIADAAAAgEAAgAMAAIAAAADAAwAAgAgAAIADAACACUAA4AMAAIANQADgBwCAgB1AAP6/v++AHQAA/r+/3gABAAD+AwMAAAEAAIADAAAAAYAAAAMAAAAJAAAAAwAAAQALAAADAAABMAoAAAMAAAAYAAAAAwAAAAAAAAADAAA="},{"view":2,"source":"r7-orange-compact","bits":"AAAAAIADAAAAgEAAgAMAAIAAAADAAwAAgAgAAIADAACACUAA4AMAAIANQADgBwCAgBVAAP6/ve+AHQAA/r+/3gABAAD+AwMAAAEAAIADAAAAAYAAAAMAAAAJAAAAAwAAAQALAAADAAABMAoAAAMAAAAYAAAAAwAAAAAAAAADAAA="},{"view":0,"source":"legacy-white-current","bits":"AAAAAABgBgAAAAAAAGAGAAAAAAAAYAYA8AcA+AcABgD8HwD/H4AHAP8/AP9/gAcAPzgAB36ABwAAOAAHeIAHAAA4AAd+4AcAAD4AB378///AHwAfeOAfAPA/AB94gAcA/P8w/n+ABwD8/8D4H4AHAPw/wOAfgAcAAAAAAACABwA="},{"view":1,"source":"legacy-white-current","bits":"AAAAAAAABgAAAAAAAAAGAAAAAAAAAAYA8AcA+AcABgD8HwD/HwAGAP8/AP9/gAcAMDgAB36ABwAAOAAHeIAHAAA4AAd44AcAAD4AB378///AHwAfeOAfAPA/AB94gAcA/P8A/n+ABwD8/wD4H4AHAPw/AOAfgAEAAAAAAACABwA="},{"view":2,"source":"legacy-white-current","bits":"AAAAAAAABgAAAAAAAAAGAAAAAAAAAAYA8AEA+AcABgD8HwD+HwAGAP8/AP9/gAcAMDgAB36ABwAAOAAHeIAHAAA4AAd44AcAAD4AB3j8///AHwAHeOAfAPA/AB94gAcA/P8A/n+ABwD8/wD4H4AHAPw/AOAfgAEAAAAAAACABwA="},{"view":0,"source":"legacy-yellow-shift2","bits":"AAAAAAAYAAAAAAAAABgAAAAAAAAAfwAAAAAAAAB/AAAAAAAAAP8A8AAAAAAA/wDwAAAAAMD/APAAAAAAwP8A8AEAAAYAfwAAAQAABgB/AAAHAAAGAH4AAAcAAAYAfgAABwCABwAAAAAHAIAHAAAAAAcAAAAAAAAABwAAAAAAAAA="},{"view":1,"source":"legacy-yellow-shift2","bits":"AAAAAAAAwP8AAAAAAADA/wAAAAAAAMD/AAAAAAAAAP4AAAAAAAAA/gAAAAAAAMD/AAAAAAAAwP8AAAAAAADA/wAAAAAAAMD/AAAAAAAAwP8AAAAAAADA/w8AAAAAAAAADwAAAAAAAAAPAAAAAAAAAA8AAAAAAAAADwAAAAAAAAA="},{"view":2,"source":"legacy-yellow-shift2","bits":"AAAAAAAAwP8AAAAAAADA/wAAAAAAAMD/AAAAAAAAAP4AAAAAAAAA/gAAAAAAAMD/AAAAAAAAwP8AAAAAAADA/wAAAAAAAMD/AAAAAAAAwP8AAAAAAADA/w8AAAAAAAAADwAAAAAAAAAPAAAAAAAAAA8AAAAAAAAADwAAAAAAAAA="}],"1.0":[{"view":0,"source":"field_01.jpeg","bits":"AAAAAIBPAAAAAAAAgF8AAAD+BwCAXwAAgP9/AIBfAAAA3vwBgF8AAMAD+AGAXwAAwAPgAwDeAADgA/ADgB8AAOAD+APgfwAA4APwA/D/7u/gA/gD+P/sTeAD+AfI/wRA4AP4A8D/AADAB/kDwP8AAPP9/wGA/wAAAfw/AID/AAA="},{"view":1,"source":"field_01.jpeg","bits":"AAAAAIAPAAAAAAAAAF4AAAD0BwAAXgAAAPZ/AABeAAAA3nwAAF4AAIAD4AGAXwAAwAPgAwBeAADgA+ADgB8AAOAD4APgfwAAwAPgA/D/7u/AA/AD8P/sTcAD8API/wQAwAPwA8D/AADAB/kDwP8AABP8fwCA/wAAAfg/AAD+AAA="},{"view":2,"source":"field_01.jpeg","bits":"AAAAAAAPAAAAAAAAAL4AAAD0DwAAvgAAAPb/AAC+AAAAzvwAAL4AAAADwAEAvwAAwAPAAwC+AADgA8ADAD8AAOADwAPA/wAAwAPAA+D/2d/AA+AD4P/Zm8AD4AOQ/wkAwAPgA4D/AQDAB/EDgP8BABP8/wAA/wEAAfh/AAD+AQA="},{"view":0,"source":"field_02.jpeg","bits":"AAAAAAD4AQAAAAAAAPgBAAEA8H8A+AEAAQD4/wD4AQABADzwAfABAAEAHPAB+AEAAQAc8AHwAQABABzwAfwBAAEAHPAB////AQAcwAP///8BABzAAf8XAAEAHMAB+AMAAQAcwAH4AwADQPz/AfABAAfA4H8A8AEAB8DAfwDgAwA="},{"view":1,"source":"field_02.jpeg","bits":"AAAAAADwAQAAAOAfAPgBAAEA8H8A+AAAAQA4/wDwAQABABzwAfgBAAEAHMAB+AEAAQAcwAHwAQABABzwAfwDAAEAHMAB/v//AQAcwAH+//8BABzAAfgDAAEAHMAB+AMAAQD4/wH4AQADQPj/AfADAAPA4H8A8AMAAAAAAADgAwA="},{"view":2,"source":"field_02.jpeg","bits":"AAAAAADwAQAAAOAfAPgBAAEA8H8A+AAAAQA4/ADwAQABABzwAfABAAEAHMAB+AEAAQAcwAHwAQABABzwAfwBAAEAHMAB/v//AQAcwAH+//8BABzAAfgDAAEAHMAB+AEAAQD4/wH4AQADQPj/AfADAAPA4H8A8AEAAAAAAADgAQA="},{"view":0,"source":"field_04.jpeg","bits":"AADwPwDAAwAAAPg/AOADAACA//8B8AMAAIAf4gHwAwAAAA7wAeADAAAADvAB4AMAAAAO8AH4AwAAAA7gAf7//wAADvAB/v//AAAO4AH4L8AAAA7gAeADAAAAOOAB4AMAA2D4/wHAAwADAPA/AMADAAMAwDcAwAMAAAAAAADAAwA="},{"view":1,"source":"field_04.jpeg","bits":"AADwPwDAAwAAAPg/AOADAAAA//8B4AMAAAAf4gHgAwAAAA7wAcADAAAADvAB4AMAAAAO8AH4AwAAAA7gAf7//wAADuAB/v//AAAO4AH4L8AAAAzAAeADAAAAOOABwAMAA2D4/wHAAwADAOA/AMADAAMAgCcAwAMAAAAAAADAAwA="},{"view":2,"source":"field_04.jpeg","bits":"AADwPwDAAwAAAPg/AOADAAAA//8B4AMAAAAf4gHgAwAAAA7wAcADAAAADvAB4AMAAAAO8AH4AwAAAA7gAf7//wAADuAB/v//AAAO4AH4D8AAAAzAAeADAAAAOOABwAMAA2D4/wHAAwADAOA/AMADAAMAgCcAwAMAAAAAAADAAwA="},{"view":0,"source":"field_06.jpeg","bits":"AAAAAACAAwAPAID/AYADAB8AAP8DgAcAHwDgBx+AAwAeAMABHsAHAB4AwAEewAcAHgCAAR/wBwAeAMABP/7/vh4AwAF//v//HgDAAx/4DwAcAMABHoAHABwAwA8fgAcA/wCM/x+ABwD/AAT/AwAHAAAAAAAAAAYAAAAAAAAABwA="},{"view":1,"source":"field_06.jpeg","bits":"AAAAAACAAwAPAAD/AYADAA8AAP8DgAMAHgDgBx+AAwAeAMABHIAHAB4AwAEewAcAHACAAR7gBwAcAMABHv7fvh4AwAF+/v//HgDAAx74DwAcAMABHoAHABwAwAsfgAcA/wCM/x+AAwD/AATzAwADAAAAAAAAAAYAAAAAAAAABgA="},{"view":2,"source":"field_06.jpeg","bits":"AAAAAACAAwAPAAD/AYADAA8AAP8DgAMAHgDgAx+AAwAeAMABHIAHAB4AwAEewAcAHACAAR7gBwAcAMABHv7fvh4AwAF+/v//HgDAAx74DwAcAMABHoAHABwAwAsfgAcA/wCM/x+AAwD/AATzAwADAAAAAAAAAAYAAAAAAAAABgA="},{"view":0,"source":"field_07.jpeg","bits":"AAAAAAAAwAAAAAAAAADAAAAAAMAAAMAAAAAAwAUAwAAHAADgRwCAAAMAAMDPAIAABwAAmuAAAAYGAAAC4ACAJAQAAALBAMBvBAAAA8AAwG8GAAACwAD+704AAALAAPjvTAAAAIAA+O8YAAAEAACATQgAAASAAAAN2AAAIPsBAAk="},{"view":1,"source":"field_07.jpeg","bits":"AAAAwAAAQAAAAADAAgBAAAcAAOADAEAAAwAAwGMAQAADAAAcMQAAAAcAAABAAAACBAAAAnAAwDMEAAACQADgBwQAAAJAAOA3BgAAAkAA+ndOAAACQAD89wwAAABAAPx3CAAAAIAAgCcIAAAAgACABwgAAADwAIABeAAAePgAAAE="},{"view":2,"source":"field_07.jpeg","bits":"AAAAwAAAQAAAAADAAgBAAAcAAOADAEAAAwAAwGMAQAADAAAcMQAAAAcAAABAAAACBAAAAnAAwBMEAAACQADgBwQAAAJAAOA3BgAAAkAA+jdOAAACQAD89wwAAABAAPx3CAAAAIAAgCcIAAAAgACABQgAAADwAIABeAAAePgAAAE="},{"view":0,"source":"field_08.jpeg","bits":"/DgAAAAAAAD+MAAAAAAAAL4yAAAAAAAA/z8AAAAAAAD/PwCAAwBUAP8+AMADAOwCAAAAAAMA0gMAAAAAAwACAgAAAAADAAICAAAAAAMAA4IAAAAAA4DDwwAAAAADgMODAAAAAAOA1wcAAAAADgD/BwAAAAAIAP4BAAAAAAAABAA="},{"view":1,"source":"field_08.jpeg","bits":"fDAAAAAAAAB+IAAAAAAAAL4yAAAAAAAA/z8AAAAAAAD/PwCAAwAUAP82AMADAOwAAAAAAAMAUAMAAAAAAwACAgAAAAADAAICAAAAAAMAAwIAAAAAA4BDwwAAAAADgMMDAAAAAAOA1wcAAAAADAD/AwAAAAAIAP4BAAAAAAAABAA="},{"view":2,"source":"field_08.jpeg","bits":"fDAAAAAAAAB8IAAAAAAAAL4yAAAAAAAA/z8AAAAAAAD/PwCAAwAQAP82AMADAOwAAAAAAAMAUAMAAAAAAwACAgAAAAADAAICAAAAAAMAAwIAAAAAA4BDwwAAAAADgIMDAAAAAAOA1wcAAAAADAD/AwAAAAAIAP4BAAAAAAAABAA="},{"view":0,"source":"field_10.jpeg","bits":"fAAAAOA/AAB8AAAA4H8AAPwBAID//wEA/AEAgAPwBwDwAQCAA/AHAPABAIAD8AeA/AMAwAPwD8D8BwDAA/AP+PwHAPAP8Af4/AMA8A/wD/j8AwDwD/APAPwDAMAP8AcA/wcAsP//DwD+DwAM/n8HAP4PAAaMfwAAzA8AAIA3AAA="},{"view":1,"source":"field_10.jpeg","bits":"PgAAAPAfAAA8AAAA8D8AAD4AAAD+/wEAfAAAwAPwAwB8AADAA/ADAHwAAMAD8AOAfAAAwAPwD8D8AQDgA/AP8P4DAOAD8APw/gEA8AfwD/j+AQDwA/APAP4BAOAH8AMA/wMAwP//AwD+BwAC/j8DAPwHAAKEHwAA4AcAAIAHAAA="},{"view":2,"source":"field_10.jpeg","bits":"PgAAAOA/AAA8AAAA4H8AAD4AAAD+/wMA/AAAgAfgBwD8AACAB+AHAPwAAIAH4AcA/AAAgAfgH4D8AQDgB+AfwP4DAOAH4AfA/gEA8A/gH/D+AQDwB+AHAP4BAOAP4AcA/wMAgP//BwD+BwAE/n8GAPwHAAQIPwAA4AcAAAAPAAA="},{"view":0,"source":"new-white","bits":"DwAAAAAAAJgPAAAAAAAAmA8AcAAA/AOYDwDwAQD8B5gDAPABAP4f+AAAwAOAAx/4AADAA4ADH/gAAIADgAMc+AAAgAOAAx//AACAA4ADH/8AAIADgAMf4AAAgAOADxzgAADwDxj+H+AAAPAPGP4f4AAA8A9g/AfgAACAAQAAAAA="},{"view":1,"source":"new-white","bits":"DwAAAAAAAIAPAAAAAAAAgA8AAAAAAACADwAwAADwB4ADAHAAAPAfmAAAwAGAAx/4AADAAYADH/gAAAACgAMc+AAAAAKAAxz4AAAAAoADHPsAAAACgAMf/wAAgAOAAxzgAACAA4APBOAAAPAPGP4H4AAA8A8Y/gfgAACAA2AMBAA="},{"view":2,"source":"new-white","bits":"DwAAAAAAAIAPAAAAAAAAgA8AAAAAAACADwAwAADwB4ADAHAAAPAHmAAAwAGAAx/gAADAAYADH/gAAAAAgAMc+AAAAACAAxz4AAAAAoADHPsAAAACgAMc/wAAgAOAAxzgAACAA4APBOAAAPAPGP4H4AAA8A8Y/gfgAACAA2AMBAA="},{"view":0,"source":"new-yellow","bits":"AAAAAAAAwAAAAAAAAADAAAAAAAAAAMAfAAAAAAAAwB8AAAAAAADAPwAAAAAAAMA/AAAAAAAA+P8AAAAAAAD4/wAAAAAAAPj/AAAAAAAA+P8DAAAAAAD4PwMAAAAAAPg/AwAAAAAAwB8DAAAAAADAHwMAABwAAAAcAwAAHAAAABw="},{"view":1,"source":"new-yellow","bits":"APD/DwDw/w8A8P8PAPD/DwDw/w8A8P8PAPD///////8A8P////////////////////////////////////////////////////////////////////////////////8P/////////w8A8P8PAPD/DwDw/w8A8P8PAPD/DwDw/w8="},{"view":2,"source":"new-yellow","bits":"APD/DwDw/w8A8P8PAPD/DwDw/w8A8P8PAPD//////w8A8P//////D/////////////////////////////////////////////////////////////////////////8P/////////w8A8P8PAPD/DwDw/w8A8P8PAPD/DwDw/w8="},{"view":0,"source":"r3-green","bits":"AAAAAACAPwAAAAD4D4A/ABgAAPwPgD8AHAAA/z8APgAfAAAcDAA+AH8AAARMgD8AfwAABEyAPwB8AAAEzP//83wAAB/8+f//fAAAH3zgPwB/AAAfTIA/AH8AwH9MAD4A/AEAB3AAMAB4AAAEDwAwAPwBAAAAADAAAAAAAAAAMAA="},{"view":1,"source":"r3-green","bits":"AAAAAACAMwAAAAD4AwA+ABgAAAAAADIAGAAA/w8APgAfAAAcDAA+AH8AAARAAD4AfAAAAECAPwBgAAAEwOf/w2AAABzA+f/zZAAAHEzgPwBkAAAfQIA/AHwAAH9MADIAfAAAB3AAAAAAAAAADAAwAHgAAAAAADAAAAAAAAAAMAA="},{"view":2,"source":"r3-green","bits":"AAAAAACAMwAAAAD4AwA+ABgAAAAAADIAGAAA/w8APgAfAAAEDAA+AB8AAARAAD4AfAAAAECAPwBgAAAEwOH/w2AAABzA+f/zZAAAHEyAPwBkAAAfQIA/AHwAAH9MADIAfAAAB3AAAAAAAAAADAAwAHgAAAAAADAAAAAAAAAAMAA="},{"view":0,"source":"r3-red","bits":"AAAAAAAAAwAAAAAAAAADAB4AAP8AAAMAPgCA/w8AAwA/AADjDwADACYAAIMPwA8AZgAAgz/wDwBgAACDP/wP8GAAAIMP/v//YABggz/+//9gAGCDP/7///4BeIM/wA8AfgBg7z/ADwD+Afj/P/APAP4BmP8PwA8AZgAAYADADwA="},{"view":1,"source":"r3-red","bits":"AAAAAAAAAwAAAAAAAAADAAYAAJ8AAAAAIAAAfw8AAAAnAADjDwAAACYAAIMPAAMAIAAAgz/wDwAgAACDP/wP8GAAAIMP/v//YABggz/w//xgAACDP/7///gBYIM/wA8AfgBggzPADwD+AXj/P8APAPgBgIMPwA8AYAAAYADADAA="},{"view":2,"source":"r3-red","bits":"AAAAAAAAAwAAAAAAAAADAAMAAM8AAAIAMAAAPw8AAgAzAADzDwACADMAAMMPAAMAMAAAwx/wDwAwAADDH/wPwDAAAMMP////MAAwwx/w//wwAADDH///+/wAMMMfwA8APwAwwxPADwD/ADz/H8APAPwAwMMPwA8AMAAAAADADgA="},{"view":0,"source":"r3-yellow","bits":"//8BAAAAAAD//wEAAAAAAP//AQAAAAAA//8BAAeAfwAfxgEABuD/AQAAAIAH4P8BAAAAgAfg/wEAAACAB+DxwQAAAIAHgPHxAAAAgB+A8fkAAAAAB4Dx+QAAAIAHgPHBAAAAgAeA8cEAAACAH4D/wQAAAIAfgEEAAAAAgB8AfgA="},{"view":1,"source":"r3-yellow","bits":"//8BAAAAAAD//wEAAAAAAP//AQAAAAAA/v8BAACATwAOxgEAAODPAQAAAIAGgL8BAAAAgAaAvwEAAACABgDwAQAAAIAGgPHBAAAAAB8A8PkAAAAABgDw+QAAAIAGAPDBAAAAgAYA8MEAAACAHgD+wQAAAAAYgEEAAAAAgB8AfgA="},{"view":2,"source":"r3-yellow","bits":"//8BAAAAAAD//wEAAAAAAP//AQAAAAAA/v8BAACATwACwAEAAODPAQAAAIAGgL8BAAAAgAaAvwEAAACABgDwAQAAAIAGgPHBAAAAAAcA8PkAAAAABgDw+QAAAAAGAPDBAAAAAAYA8MEAAACAHgD+wQAAAAAYgEEAAAAAgB8AfgA="},{"view":0,"source":"r3-white","bits":"AAAAAIAHAIAAAAAAgAcAgAAAAACABwCAgM8GAIAHAIBgABgAgAcAgIAzYQD4BwCAgANmAPgfAICAA2AA+AcAgIADZwD4BwCAnANmAP7///+cA2cA4P///5wDfwD+/z/+hAN/APgfAOCcw38A+B8AgJzzfwD4HwCAm/9/APgfAIA="},{"view":1,"source":"r3-white","bits":"AAAAAIAHAIAAAAAAgAcAgAAAAACABwCAAAAAAIAHAIBgAAAAgAcAgIAzYACYBwCAgANgAPgHAICAA2AA+AcAgIADAAD4BwCAgANmAPj/+f+AA2YA4P/5/wAAZgDg/z/+BABnAPgfAOAcAH8A+B8AgATwBwD4HwCAAwB+AOAfAIA="},{"view":2,"source":"r3-white","bits":"AAAAAIAHAIAAAAAAgAcAgAAAAACABwCAAAAAAIAHAIBgAAAAgAcAgIAzYACYBwCAgANgAPgHAICAA2AA+AcAgIADAAD4BwCAgANmAPj/+f+AA2YA4P/5/wAAZgDg/z/+BABnAPgfAOAcAH8A+B8AgATwBwD4HwCAAwB+AOAfAIA="},{"view":0,"source":"r4-green-compact","bits":"AAAAAADgHwAAAAD/B+AfAAAAAH8G4B8AGAAA/x/gHwAfAAAPBuAfAH8AAANg4B8AewAAA2DgHwBgAACD//x/gGQAAIP////7ZwAAj//8//t/AACPf/B/AH8A4A9m4B8AfwDgv2eAHwD8AIADeIAZAHwAAD8GABgAfAAAAAAAGAA="},{"view":1,"source":"r4-green-compact","bits":"AAAAAADgGQAAAAD8AeAfAAAAAAAAgBkAAAAA/wGAHwADAAAPAOAfAGAAAAAA4B8AYAAAAGDgHwBgAAAA4PB/gGAAAADm/P/7ZAAADOb8//hnAAAPYPAfAH8AAA9g4B8AfwBgPwCAGQD8AIADGAAYAHgAAAMAABgAeAAAAAAAGAA="},{"view":2,"source":"r4-green-compact","bits":"AAAAAADgGQAAAAD8AeAfAAAAAAAAgBkAAAAA/wGAHwADAAAPAOAfAAAAAAAA4B8AYAAAAGDgHwBgAAAAYPB/AGAAAADm/P/7ZAAADGb8//hnAAAPYOAfAH8AAA9g4B8AfwBgPwCAGQD8AIADGAAYAHgAAAMAABgAeAAAAAAAGAA="},{"view":0,"source":"r6-blue","bits":"fwAAAAAA4AB/AAAAAADgAH8AAAAAAOAAfwAAAOAZ4ABwAIAB+H/gAAAAsAHAfvgAAADwASB+/AMAAMABIH7//wAA8AEYfv//AADwAeB++AcAAPAH+H/4AwAAAAbgH+AAAADAB8AH4AAAAAAAAADgAAAAAAAAAOAAAAAAAAAA4AM="},{"view":1,"source":"r6-blue","bits":"fwAAAAAA4AB/AAAAAADgAH8AAAAAAOAAfwAAACAY4ABwAAAA2HngAAAAMADAZuAAAACwAQB+/AMAAIABAH77/wAAgAEAfv//AACwAcB++AMAAAAGwH/4AwAAAAAgGOAAAADAB8AH4AAAAAAAAADgAAAAAAAAAOAAAAAAAAAA4AA="},{"view":2,"source":"r6-blue","bits":"fwAAAAAA4AB/AAAAAADgAH8AAAAAAOAAfwAAACAY4ABwAAAA2HngAAAAMADAZuAAAACwAQB+/AMAAIABAH77/wAAgAEAfv//AACAAQB++AMAAAAGwH/4AwAAAAAgGOAAAADAB8AH4AAAAAAAAADgAAAAAAAAAOAAAAAAAAAA4AA="},{"view":0,"source":"r7-green-compact","bits":"/wcAAAAAAAD/BwAAAAAAAP8HAAAAAAAA/wcAAAAAAAD/BwAAAAAAAP8HAAAAAAAA/wcAAAAAAAD/BwAAAAAAAP8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P8="},{"view":1,"source":"r7-green-compact","bits":"/wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P8="},{"view":2,"source":"r7-green-compact","bits":"/wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P//BwAAAADg//8HAAAAAOD//wcAAAAA4P8="},{"view":0,"source":"r7-red-compact","bits":"AAAAAACAAwAAAAD/AAADAA8AgP8AAAMADwDA/weAAwAPAMDBB4APAB8AwIAPgA8AHwDAgA+ACwAeAMCAD/wPgB4AwIEP/v/+HgDAAQ/8//4eAMCBD+AfAB4AwAEPwB8APwCA/w/gHwB/AIL/D8AfAH8AgP8AwB8ALQAAMACAHwA="},{"view":1,"source":"r7-red-compact","bits":"AAAAAAAAAwAAAAD/AAADAA8AgP8AAAMADwDA/wcAAwAPAMCBBwAHAB8AwIAPgA8AHwDAgA+ACwAeAMCAD/wPgB4AwAAP/t++HgDAAQ/8//4eAMABD8AfAB4AgAEPwB8APwCA/w/gHwB/AID/B8AfAH8AgP0AwB8ALQAAMACAHwA="},{"view":2,"source":"r7-red-compact","bits":"AAAAAAAAAwAAAAD+AAADAA8AgP8AAAMADwDA/wcAAwAPAMCBBwAHAB8AwIAPgA8AHwDAgA+ACwAeAMCAD/wPAB4AwAAP/t++HgDAAQ/83/4eAMABD8AfAB4AgAEPwA8APwCA/w/AHwB/AID/B8AfAH8AgP0AwB8AKQAAMACAHwA="},{"view":0,"source":"r7-orange-compact","bits":"APgPAAAHAAAA+P8EAAcAAAAJwAAABgAAAAHAAAAHAAAAAcAAgAcAAAABwACABwAAAACACO4PAAAAA8AB////uwADwAH///f7AAPACf8PAAAAA8AZ4A8AAAAAwAHABwAAAIDBAcAHAAAD/J8BgAcAAAP4DwAgBwAAAvAaAGAHAAA="},{"view":1,"source":"r7-orange-compact","bits":"APgPAAAFAAAA8H8AAAcAAAAJwAAABgAAAAHAAAAHAAAAAcAAAAcAAAAAwACABwAAAACACOwPAAAAA8AB/3//uwADwAH///f7AAPAAf4PAAAAAsAY4A8AAAAAwAGABwAAAIDBAYAHAAAC/A8AgAcAAAP4DgAABwAAAnAIACAHAAA="},{"view":2,"source":"r7-orange-compact","bits":"APgPAAAFAAAA8H8AAAcAAAAJwAAABgAAAAHAAAAHAAAAAcAAAAcAAAAAwACABwAAAACACOwPAAAAA8AB/3/3uwADwAH///f7AAPAAf4PAAAAAsAY4A8AAAAAwAGABwAAAIDBAYAHAAAC/A8AgAcAAAP4DgAABwAAAnAIACAHAAA="},{"view":0,"source":"legacy-white-current","bits":"AAAAAACAGQAAAAAAAIAZAA8AAPgHgBkAPwAA+B+AGQA/AAD+f4AfAHwAwAd+gB8AfADAB36AHwBwAMAHeIAfAHAAwAd++P//cADAB374f/BwAMAHfgAeAHAAwB94AB4A/wMM/n8AHgD/Awz+fwAeAP8DMPgfAB4AMAAAAAAAAAA="},{"view":1,"source":"legacy-white-current","bits":"AAAAAAAAGAAAAAAAAAAYAAAAAAAAABgAAwAA4B8AGAAPAADgf4AZADwAwAd+gB8APADAB36AHwBAAMAHeIAfAEAAwAd4gB8AQADAB3iY//9AAMAHfvh/wHAAwAd4AB4AcADAHxgAHgD/Awz+HwAeAP8DDP4fAB4AcAAwGBgAAAA="},{"view":2,"source":"legacy-white-current","bits":"AAAAAAAAGAAAAAAAAAAYAAAAAAAAABgAAwAA4B8AGAAPAADgH4AZADwAwAd+AB4APADAB36AHwAAAMAHeIAfAAAAwAd4gB8AQADAB3iY//9AAMAHePh/AHAAwAd4AB4AcADAHxgAHgD/Awz+HwAeAP8DDP4fAB4AcAAwGBgAAAA="},{"view":0,"source":"legacy-yellow-current","bits":"AAAAAADg//8AAAAAAOD/////BwAA4P////8HAADg/////wcAAOD/////BwAA4P////8HAADg//////////////////////////////////////////////////////////////////////////////////////////////////8="},{"view":1,"source":"legacy-yellow-current","bits":"/////////////////////////////////////////////////////////////////////////////////////wAA+P//////AAD4//////8AAPj//////wAA+P//////AAD4//////8AAPj//////wAA+P//////AAD4//////8="},{"view":2,"source":"legacy-yellow-current","bits":"//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAAAAAP//BwAAAAAA//8HAAAAAAD//wcAAAAAAAAA+P//////AAD4//////8AAPj//////wAA+P//////AAD4//////8AAPj//////wAA+P//////AAD4//////8="},{"view":0,"source":"legacy-yellow-shift2","bits":"AAAAAAAGAAAAAAAAAAYAAAAAAAAAfgAAAAAAAAB+AAAAAAAAAP4AwAAAAAAA/gDAAAAAAAD/A/AAAAAAAP8D8AAAAAAA/wPAAAAAAAD/A8ABAAAAAP8AAAEAAAAA/wAAAQAAAAB+AAABAAAAAH4AAAEAMAAAYAAAAQAwAABgAAA="},{"view":1,"source":"legacy-yellow-shift2","bits":"8MEHAAAAAADwwQcAAAAAAPDBBwAAAAAA8P8fAAAAAADw/x8AAAAAAP//HwAAAADw//8fAAAAAPD//x8AAAAA8P//HwAAAADw//8fAAAAAPD//x8AAAAA8P//BwAAAAAA//8HAAAAAADwwQcAAAAAAPDBBwAAAAAA8MEHAAAAAAA="},{"view":2,"source":"legacy-yellow-shift2","bits":"8MEHAAAAAADwwQcAAAAAAPDBBwAAAAAA8P8HAAAAAADw/wcAAAAAAP//HwAAAADw//8fAAAAAPD//x8AAAAA8P//HwAAAADw//8fAAAAAPD//x8AAAAA8P//BwAAAAAA//8HAAAAAADwwQcAAAAAAPDBBwAAAAAA8MEHAAAAAAA="}]}};

},
'core_v2_empirical_numeric_evidence.js': function(module,exports,require){
'use strict';
const BANK=require('./core_v2_empirical_numeric_bank.js');
const decoded=new Map();
function unpack(p){if(decoded.has(p))return decoded.get(p);const bin=(typeof Buffer!=='undefined'&&Buffer.from)?Buffer.from(p.bits,'base64'):(()=>{const s=atob(p.bits),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u})(),b=bin,a=new Uint8Array(BANK.w*BANK.h);for(let i=0;i<a.length;i++)a[i]=(b[i>>3]>>(i&7))&1;decoded.set(p,a);return a}
function normalize(row,W=BANK.w,H=BANK.h){let x0=row.w,y0=row.h,x1=-1,y1=-1;for(let y=0;y<row.h;y++)for(let x=0;x<row.w;x++)if(row.data[y*row.w+x]){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}if(x1<0)return null;const a=new Uint8Array(W*H);for(let y=0;y<H;y++){const sy=Math.round(y0+(y1-y0)*(H===1?0:y/(H-1)));for(let x=0;x<W;x++){const sx=Math.round(x0+(x1-x0)*(W===1?0:x/(W-1)));if(row.data[sy*row.w+sx])a[y*W+x]=1}}return a}
function dice(a,b){let i=0,aa=0,bb=0;for(let k=0;k<a.length;k++){if(a[k])aa++;if(b[k])bb++;if(a[k]&&b[k])i++;}return 2*i/Math.max(1,aa+bb)}
function independentSources(label,view){return new Set((BANK.labels[label]||[]).filter(p=>p.view===view).map(p=>p.source)).size}
function scoreNormalized(a,label,view){const ps=(BANK.labels[label]||[]).filter(p=>p.view===view);if(new Set(ps.map(p=>p.source)).size<2)return null;const bySource=new Map();for(const p of ps){const s=dice(a,unpack(p)),old=bySource.get(p.source);if(old==null||s>old)bySource.set(p.source,s)}const ss=[...bySource.values()].sort((x,y)=>y-x);return(ss[0]+ss[1])/2}
function scoreRow(row,label,view){const a=normalize(row);return a?scoreNormalized(a,label,view):null}
module.exports={normalize,scoreNormalized,scoreRow,independentSources,BANK};

},
'core_v2_empirical_numeric_bank.js': function(module,exports,require){
'use strict';
module.exports={"w":64,"h":16,"labels":{"0.03000":[{"view":0,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"AAAHeHw8Hw8AgB/+////PwCAHs7n7/ExAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/4AYzsDH8bH9ARzOwcfxMf0BHM7Bx/Ex+w8e/v7//z9/jx/+fn7fHx8PD/x+PB4PHw8EAAAAAADfDwAAAAAAAP8PAAAAAAAA8w8AAAAAAAA="},{"view":1,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"AAAHeHw8Hw8AgB/+////PwCAHM7nx/ExAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAYzsDH8bH8ARjOwMfxMfwBGM7Ax/Ex8w8c/vz//z9/Dx/+fn7fHx8PD/h+PB4PHw8AAAAAAADfDwAAAAAAAP8PAAAAAAAA8w8AAAAAAAA="},{"view":2,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"AAADeHw8Hg8AgB/+////PwCAHM7nx/ExAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfwAYzsDH8bH8ARjOwMfxMfwBGM7Ax/Ex8w8c/vz//z9/Dx/+fn7fHx8PD/h+PB4PDw8AAAAAAADfDwAAAAAAAP8PAAAAAAAA8w8AAAAAAAA="},{"view":0,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"AAACEAAAiAcAAA94fD/PDwCAH/j+//8/AIAf+P///x8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/gxmOwefxuf+fHf7///8ffx4e/v///x+/Hw94fDwMAL8fAAAAAAAAvx8AAAAAAAD/HwAAAAAAAPYfAAAAAAAA/h8AAAAAAAA="},{"view":1,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"AAAAAAAAgAcAAA94fD6PBwAAH/j+//8fAIAf+P///x8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD9gxkOwcPxuf+fGHL5//8Xfx4O/v9//w8/Hw94PDwMAL8fAAAAAAAAnx8AAAAAAAD/HwAAAAAAAPYfAAAAAAAA9B8AAAAAAAA="},{"view":2,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"AAAAAAAAgAcAAA94fDyPBwAAH/j+//8fAIAf+P///x8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD9gxkOwcPxuP+fGHL5//8Xfx4O/v9//w8fHw94PDQEAJ8fAAAAAAAAnx8AAAAAAAD/HwAAAAAAAPYfAAAAAAAA9B8AAAAAAAA="},{"view":0,"source":"field1503","bits":"PwD+BwDgAQD/wP9//H8GAP///////wcA////////BwDg/wf+/wB+AOD/B/7/AH4A4P8H/v8AfgDg/wf+/wB+wOD/B/7/AGLw4P8H/v8BAvjg/wf+/wF+8OD/B/7/AX4A4P8H/v8BfgD4/x/+/wF+AP///////38A/8P/fzz+HwA="},{"view":1,"source":"field1503","bits":"PwDgAQAAAAD/wP8fPAAEAP/z////fwIA//////+HAwAg/wf+/wB+AAD/B/7/AH4A4P8B/v8AYgDg/wH+/wAAwOD/B/7/AALw4P8H/v8BAvDg/wf+/wBi8OD/B/7/AX4A4P8H/v8BfgD4/x/+/wF+AP///////38A/8P/fzD+HwA="},{"view":2,"source":"field1503","bits":"PwDgAQAAAAD/wP8fPAAEAP/z////fwIA//////8HAgAg/wf+/wB+AAD/B/7/AH4A4P8B/v8AYgDg/wH+/wAAwOD/B/7/AALw4P8H/v8AAvDg/wf+/wBi8OD/B/7/AH4A4P8H/v8BfgDg/x/+/wF+AP/////8/38A/8P/fzD+HwA="},{"view":0,"source":"68DB3B38-real-004","bits":"AAAAAABEAwCAP8D2gP8DgJh/8P+D/w+APsB/AfcPHIAfwH8B5wEcgB/AfwHXDTyAH4B/AfcNPIBfgH8A9wk88B6AfwDvATzgHoB/AO8JPOBegH8A/wE8gF6AfwD/ARiAzOT7Of8DGADg/8P/hwM+AAA/gP4BsAcAAD8A8gAAAAA="},{"view":1,"source":"68DB3B38-real-004","bits":"AAAAAAAAAQAAP4B2AP8DAAB/8P6B/w8APsB/AfUHDIAcwH8B5wEcAB/AfwHUDTyAH4B/AdcNPIAfgH8A5Qk88ByAfwDvATzgHIB/AO8BPOAcgH8A/wE8gF6AfwD/ARgAjMSiMP8DGADA/4H/hwM8AAA7AP4BkAcAADYA8AAAAAA="},{"view":2,"source":"68DB3B38-real-004","bits":"AAAAAAAAAQAAP4B2AP8DAAB/4P6A/w8APsB/AfUHDIAcwH8B5wEcAB/AfwHUDTyAHoB/AccNPIAfgH8A5Qk88ByAfwDnATzgHIB/AO8BPOAcgH8A7wE8gF6AfwDvARgAjMCiEO8DGADA/4H/hwM8AAA7AP4BkAcAADYA8AAAAAA="},{"view":0,"source":"r4-new-0040","bits":"APABAPgYDAAA8AF8+Jg/AADwAXz4mD8AADAAfPiYPwcAMAD8/4A/BwAwAPz/gD8HgDMA/P+A/weAMwD8/4D/B4Dzgf3/gP8Hg/OB/f8A/AeP84f9/wA8P4/D//35GDz/fwAGgP/k//cAAAAABgDAMAAAAAAGAMAwAAAAAMAAAAg="},{"view":1,"source":"r4-new-0040","bits":"AAAAAGAAAAAAAAAAYAAAAAAAAMDgATgAAAAA+OABOAAAAAD44AE4AAAAAPjgAfgAAGAA+P8B+BwAYAD4/wH4HABiAPj/AfgcgOMB+P8B+ByA4wH4/wH4HIMBAPj/AfgcgwEA+P8B+BwDgAH44AH4/BwAAAAAgMEDHAAAAACAwQM="},{"view":2,"source":"r4-new-0040","bits":"AAAAAGAAAAAAAAAAYAAAAAAAAMDgATgAAAAA+OABOAAAAAD44AE4AAAAAPjgAfgAAGAA+P8B+BwAYAD4/wH4HABiAPj/AfgcgOMB+P8B+ByA4wH4/wH4HIMBAPj/AfgcgwEA+P8B+BwDgAH44AH4/BwAAAAAgMEDHAAAAACAwQM="},{"view":0,"source":"r7-yellow-040","bits":"AAAAAAAAAMDhA4A8AD4AgGcZgP/kNgDA3z98+t+BAPAXOH7A/wAG4AdgXoD/ABbwB+BfgP8AAOAHsF+A/wAA+AfwX4D/AAD8B/AfgP8BAPgX8F+A/wEA4BfwX4D/AADAf3h/+/UTAMD/G/h/4P8AwH4D4H+g/wDAAAAAAAAAAMA="},{"view":1,"source":"r7-yellow-040","bits":"AAAAAAAAAIAgAIA8ADAAgCABgP8AAACA3wpweJ8AAMAHIFwA+wAE4AcAVoD/ABbgB6BfgP8AAOAGsF8A/wAA+AewXwD/AAD4B/AfgP8AAPgH8F+A/wAA4BcwX4D/AADAX3B+4eUDAMB+A/B/wP4AgGwD4F+AfgCAAAAAAAAAAIA="},{"view":2,"source":"r7-yellow-040","bits":"AAAAAAAAAIAgAIA8ADAAgCABgP8AAACA3whweJ8AAMAHIFwA+wAE4AcAVoD/ABbgB6BfgP8AAOAGsF8A/wAA+AewXwD/AAD4B/AfgP8AAPgH8F+A/wAA4BcwX4D/AADAX3B+4eUDAMB+A/B/wP4AgGwD4F+AfgCAAAAAAAAAAIA="}],"0.02000":[{"view":0,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"8AcAAAAAAABwAgAAAAAAAPADAAAAAAAA8AMAAAAAAADwBgAAAAAAAPAD/PD3////4AfscD6Oj+cAAAAAAAAAAAAAAAAAAAAAMACOcMacj+cwBo5wxoyP5/AH/Pz/+/l+8Ab4zPPz+D4AAgAAAAAAAAcHAAAAAAAADwYAAAAAAAA="},{"view":1,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"8AMAAAAAAABwAgAAAAAAAPADAAAAAAAA8AMAAAAAAADwBgAAAAAAAPAD/PD3/f3/4AfMcD6Mj+cAAAAAAAAAAAAAAAAAAAAAMACOcIaMj+cwBo5wxoyP5/AH/Pz3+/l+4Ab4zPPz+D4AAgAAAAAAAAcGAAAAAAAADwYAAAAAAAA="},{"view":2,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"8AMAAAAAAABwAgAAAAAAAPADAAAAAAAA8AMAAAAAAADwBgAAAAAAAPAD/PD3/f3/4AfMcD6Mj+cAAAAAAAAAAAAAAAAAAAAAMACOcIaMj+cwBo5wxoyP5/AH/Pz3+/l+4Ab4zPPzeD4AAAAAAAAAAAcGAAAAAAAADwYAAAAAAAA="},{"view":0,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"AgAAAAAAAAAPAAAAAAAAAH8AAAAAAAAA/g8AAAAAAAD/Hx7w8//5/p+fc9j3n////x1znIefz88AAAAAAAAAAP4fc5jz39/P/AMe+fPD4fAEAQAAAAAAAP4BAAAAAAAA3AEAAAAAAACcAAAAAAAAAP4BAAAAAAAA/gEAAAAAAAA="},{"view":1,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"AgAAAAAAAAAPAAAAAAAAAH8AAAAAAAAA+gcAAAAAAAB/Hxzg8f/5fJ+fc9jXnf///x1jmAefz08AAAAAAAAAAP4fc5jzl4/P7AMO8PPD4fAEAAAAAAAAAP4BAAAAAAAA3AEAAAAAAACcAAAAAAAAAJwBAAAAAAAA/gEAAAAAAAA="},{"view":2,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"AgAAAAAAAAAPAAAAAAAAAH8AAAAAAAAA+gcAAAAAAAB/Hhzg8fv5fJ8fc9jXnf/f/x1jmAefz08AAAAAAAAAAP4fc5jzl4/PzAMO8PPD4fAEAAAAAAAAAP4BAAAAAAAA3AEAAAAAAACcAAAAAAAAAJwBAAAAAAAA/gEAAAAAAAA="},{"view":0,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"/AcAAAAAAAD8BwAAAAAAAGAAAAAAAAAA8AEAAAAAAAD4BwAAAAAAAPgDeODxfD4P8Af4+P///zsAAAAAAAAAAAAAAAAAAAAAOAfGMMfO5/n4B8Qw9///P/gP/PD///4/AAEAAAAAAAAAAgAAAAAAAP8PAAAAAAAA/w8AAAAAAAA="},{"view":1,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"/AMAAAAAAAD8BwAAAAAAACAAAAAAAAAA4AEAAAAAAAD4BwAAAAAAAPgDeODxPD4P8Af4+P///zsAAAAAAAAAAAAAAAAAAAAAKAcGIEfO57n4B8Qw9///P/AP/PD//f4fAAEAAAAAAAAAAAAAAAAAAO8PAAAAAAAA/w8AAAAAAAA="},{"view":2,"source":"775B2BF6-8AB2-4455-BDF1-6A9D8476C7C1.jpeg","bits":"/AMAAAAAAAD8BwAAAAAAACAAAAAAAAAA4AEAAAAAAAD4BwAAAAAAAPgDeODxPD4P8Af48P///zsAAAAAAAAAAAAAAAAAAAAAKAYGIEfO57n4B4Qw98//P/AP/PD//f4fAAEAAAAAAAAAAAAAAAAAAOcOAAAAAAAA/w8AAAAAAAA="},{"view":0,"source":"field1502","bits":"PwAAAAAAAPg/AAAAAAAA+D8AAAAAAADwPwAAAAAAAPA/AAAAAAAA+D8AAAAAAAD4PwAAAAAAAPg/AAAAAAAA/v///////////////////////////////////////////////wMAAPg/AAAAAAAA+D8AAAAAAADwOQAAAAAAAPA="},{"view":1,"source":"field1502","bits":"HwAAAAAAAPA/AAAAAAAA+D8AAAAAAADwPwAAAAAAAPA/AAAAAAAA+D8AAAAAAAD4PwAAAAAAAPg/AAAAAAAA+P////////////////////////////////////////////9//wMAAPg/AAAAAAAA+DkAAAAAAADwAQAAAAAAAPA="},{"view":2,"source":"field1502","bits":"HwAAAAAAAPA/AAAAAAAA+D8AAAAAAADwPwAAAAAAAPA/AAAAAAAA+D8AAAAAAAD4PwAAAAAAAPg/AAAAAAAA+P////////////////////////////////////////////8fnwMAAPg/AAAAAAAA+DkAAAAAAADwAQAAAAAAAPA="},{"view":0,"source":"field1503","bits":"/wD+f8D/BwD/z/9/8P8fAP///x///38AwP9/GP8HfADA/x+Y/wf8AcD/H4D/AfwBwP8fgP8B/AHA/x+A/wH8wcD/H4D/AfzBwP8f4P8B/MHA/x/g/wf8wcD/H/j/B/wBwP8f+P8H/AH/////////Af+P///D/38AGQD+fwD4GwA="},{"view":1,"source":"field1503","bits":"nwH4PwB4/gP/n///Af7/D/////+B//8PgP//weF/AD6A/38A4GcAMoD/fwD4ZwD+gP9/APh/AP6A/38A+H8A/oD/fwD4fwD+gP9/APh/AP6A/38A+P8B/oD/f8D//wH+gP9/wP9/AP7n//////////8f/v8f+P8/AAD4/wcAYAw="},{"view":2,"source":"field1503","bits":"nwH4PwB4/gP/n///Af7/D/////8B/v8PgP//weF/AD6A/38A4GcAMoD/fwD4ZwD+gP9/APh/AP6A/38A+H8A/oD/fwD4fwD+gP9/APh/AP6A/38A+H8A/oD/f8D/fwD+gP9/wP9/AP7n//////////8f/v8f+P8/AAD4/wcAYAw="},{"view":0,"source":"68DB3B38-real-004","bits":"AAAASAAAAADADwD+ALAPAMg/wP/Dvx8AfPg+EfcLHAAu8H4B/wswAC7wfgP/C3AAL/B/A/8LMAAv8H8D/wMwwA/wfwH/CzDwL+B/A/8PcPAP4H8D/wtwAA/gfwPPA2AAf8B9G48POAD8n8D/B/AfAPgfAP4A4AcAAAAAeADAAAA="},{"view":1,"source":"68DB3B38-real-004","bits":"AAAAAAAAAADABwD+AAAPAMA/wP/Dtx8ALPg+EPcLHAAO8H4B9wswAA7wfgP/A3AADvB/A/8DMAAO4H8D/wMwwA7gfwH/CzDgDuB/A/8HcIAO4H8B/wtwAA/AfwHPA2AAOoB9Gg8GEAD4n4D+BmAfANAdAPwA4AcAAAAAGAAAAAA="},{"view":2,"source":"68DB3B38-real-004","bits":"AAAAAAAAAADABwD+AAAPAMAfwP+Dtx8ALPg+EPcLHAAO8H4B9wswAA7wfgP/A3AADvB/A/8DMAAO4H8D/wMwwA7gfwD/CzDgDuB/A/8HcIAO4H8B/wtwAA/AfwHPA2AAGoB9Gg8GEAD4n4D+BmAfANAdAPwA4AcAAAAAGAAAAAA="},{"view":0,"source":"r4-new-0040","bits":"AAMAAAcADPAmMD/wfwD8DyYwP/B/APwPwDAP8H+AHwDAPAP+H4B/AMAwA/wfgH8AADAD8B/gfwAAPADwH+AfAAAwAPAf4B8AADAA8B/mHzDHPwDwH+Yf8Mc/APAf5h/w+DMD8pj/E/jgM/D/4f8D8AADAAwAGAAwwAMAAIABADg="},{"view":1,"source":"r4-new-0040","bits":"DAwAPAAA8AAADgA8DwAQAAAOADwPABAAAM4A/A/AcwAAzgD8D8BzAAAOAPwPwHMAAA4A/A/AHwAADgD8AMAfAAAOAPwAwB8AAA4APADAEwDADwAwDMMTAD8OADDMwxMAPw4AMMzDEwA8AgwM8PMD8AAAAAAADAAwAAAAAAAAADw="},{"view":2,"source":"r4-new-0040","bits":"DAwAPAAA8AAADgA8DwAQAAAOADwPABAAAM4A/A/AcwAAzgD8D8BzAAAOAPwPwBMAAA4A/A/AHwAADgD8AMAfAAAOAPwAwB8AAA4APADAEwDADwAwDMMTAD8OADBMwxMAPw4AMEzDEwA8AgwM8PMD8AAAAAAADAAwAAAAAAAAAAw="},{"view":0,"source":"r6-green-dec","bits":"AAAAgE8AAAAAAACA/wcAAAAAAID/BwAAMOABgL/hAwA84AGQD+ADYD/gAYAP4ANgP+ADkA/gAwAP4AOQD+ADgA+AA/AP4AOAD4AD8A/gA4A/gAPwD2DA+/8BAJD/Z////wEAkP9n////BwAA/+f///8ZAAAA+POf8xkAAAD+858="},{"view":1,"source":"r6-green-dec","bits":"AAAAAAwAAAAAAACAfwAAAAAAAIB/AAAAAIABgD8AAAAMgAGAD+ADAA+AAYAPgAMAA4ADgAPgAwADgAOAA+ADgAOAA4AD4ACAA4ADgAPgAIAPgAGADwAAAP8AAAD/ATB//wAAAP8BMH//BwAA/4cwf/8ZAAAA+DMbMAEAAACYMxs="},{"view":2,"source":"r6-green-dec","bits":"AAAAAAwAAAAAAACAfwAAAAAAAIB/AAAAAIABgD8AAAAMgAGAD+ADAA+AAYAPgAMAA4ADgAPgAwADgAOAA+ADgAOAA4AD4ACAA4ADgAPgAIAPgAGADwAAAP8AAAD/ATB//wAAAP8BMH//BwAA/4cwf/8ZAAAA+DMbMAEAAACYMxs="},{"view":0,"source":"r7-white-020-010","bits":"AAAAAAAAAID/AP8P8D8AgP+B/x/8/wCA/+83/h/iAYDA/wP8P4YBgMD/A/w/gAPAgP8D/B/AA8DA/wP4P8AD8MD/A/g/wAP4wP8D+D+AA/yA/wPwPIAD4MD/A/w/gAPgwN8D/D8AA4D/35v//w0DgP8B/g/g/wCAfwDsB8D/AIA="},{"view":1,"source":"r7-white-020-010","bits":"AAAAAAAAAID/AP4H8B8AgP+B/x/4fwCA/883fh/AAYDA/wP8PoABgID/A/g/gAOAgP8D+B+AA4CA/wP4P4AD4MD/A/g/gAP4wP8D+D+AA/iA/wPwPIAD4MD/A/g+gAOAgN8D+D8AA4Dzn5v+/gEDgP8A/gfA/wCAfwBoBsD/AIA="},{"view":2,"source":"r7-white-020-010","bits":"AAAAAAAAAID/AP4H8B8AgP8B/x/4fwCA/88zfh/AAYDA/wP8PoABgID/A/g/gAOAgP8D+B+AA4CA/wP4P4AD4MD/A/g/gAP4wP8D+D+AA/iA/wPwPIAD4MD/A/g+gAOAgM8D+D8AA4Dxn5v+fgADgP8A/gfA/wCAfwBoBsD/AIA="},{"view":0,"source":"r7-yellow-040","bits":"AAAAAACAAAAACIB+AP4DAMB/YP/A/wPAf/P+gPsXDMAf4P+A/wcMQB/A/wD7BxwAH8D/APsHHMA/wH8A/wccwB/AfwD3ARzwH8B/APcFHPA/wH+A/wEcwD/Af4D/AQzAZvL9nP8BDADg/+H/wwEfAIAfAP8A2QOAgB8AeQAAAIA="},{"view":1,"source":"r7-yellow-040","bits":"AAAAAACAAACAP0A7gP8DAIA/eP/A/wcAH+D/gPoDBEAewP+A8wEMAB/A/wDqBxxAH8D/AOsHHMAfwH8A8gUc+B7AfwD3ARzwHsB/APcBHPAewH8A/wEcwD/AfwD/AQwARmJRmP8BDADg/8D/wwEeAIAdAP8AyAMAABsAeAAAAAA="},{"view":2,"source":"r7-yellow-040","bits":"AAAAAACAAACAP0A7gP8DAIA/cP/A/wcAH+D/gPoDBEAewP+A8wEMAB/A/wDqBxxAH8D/AOMHHMAfwH8A8gUc+B7AfwDzARzwHsB/APcBHPAewH8A9wEcwD/AfwD3AQwARmBRiPcBDADg/8D/wwEeAIAdAP8AyAMAABsAeAAAAAA="},{"view":0,"source":"r7-red-020-010","bits":"wAeABwD8AQDAH8D/AOQBAP9//vflbwQAP/m+4P0BBIAf8D7A/QEEgB/gvoD/AQSAH+A+gP8BBIAf4D6A/QEM+B/gPoT/AQz4Hvh+gP0DDvge+H6A/AMPwB/4foD9kwfAH/p+wPubB4DF/2D7Af0PgIB+AP8B+AOAAAgAYAC4AQA="},{"view":1,"source":"r7-red-020-010","bits":"AAUAAADwAQDAH0AfAOQAAPg/6PfhZQAAG7C+wP0BBAAfoD6A/QEEABrAPoD/AQQADuA+gP0BBAAf4D6A/QEE+B/gPoD/AQz4Hvh+gPkBDPge+H6A/AEPwB/4foD9gQeAH/h+gBubA4CA/2C7AfkHgIA0AL8A+AMAAAgAIACgAAA="},{"view":2,"source":"r7-red-020-010","bits":"AAUAAADwAQDAH0AfAOQAAPg/6PfhZQAAG7C+wP0BBAAfoD6A/QEEABrAPoD/AQQADuA+gP0BBAAf4D6A/QEE+B/gPoD9AQz4Hvh+gPkBDPge+H6A+AEPwB/4PoD5gQeAH/h+gBubA4CA/2C7AfkHgIA0AL8A+AMAAAgAIACgAAA="},{"view":0,"source":"legacy1502-current","bits":"AAAAAP7/A/4BAP////8D/v///////wP+////////B/7//////z8D/v//////PwD+//////8/AP7+////H/yA//7///8f/IP//v///x/85//+////H/z///7///8f/P///v///3/+/////////////////////4f/////////g38="},{"view":1,"source":"legacy1502-current","bits":"AAAAAAAAAP4BAP///zMA+AEA//8H8AD4//////8/A/j//////z8A+P//////PwD+/////38+AP7+////HzwA/v7///8fPID//v///wc8h//+//P/Bzzn//7/w/8HPP///v///x/8///+/////z//////////PwB+////////AHg="},{"view":2,"source":"legacy1502-current","bits":"AAAAAAAAAP4BAP///zMA+AEA//8H8AD4//////8/A/j//////z8A+P//////PwD+/////38+AP7+////HzwA/v7///8fPID//v///wc8h//+//P/Bzzn//7/w/8HPP///v///x/8///+/////z//////////PwB+////////AHg="}],"0.01000":[{"view":0,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"/AA+eODHv3/+Af95+P////4B/3n4/////wHDefj///MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgPDYXj8+McPA8NheP7/xw8Dw2F4/v/HzgPP+fn////+Af/54ce/f/4B//nhx79//AB8+OGHD38="},{"view":1,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"/AA+eODHv3/+Af55+P////4B/nn4/////gHDYfj/+/MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgPDYTj8+McPA8NhOPz7xw8Dw2E4/PvHDgPDefj////+Af/54cc/f/4B//nhxz9//AB8+OGHD38="},{"view":2,"source":"07661DF6-7709-4DBA-A47A-5BD5C8CC0648.jpeg","bits":"/AA8eODHv3/+Af55+P////4B/nn4////7gHDYXj++/MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgPDYTj8+MMPA8NhOPz4xw8Dw2E4/PjHDgPDefj////+Af/54cc/f/4B//nhxz9//AB8+OGHD38="},{"view":0,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"/AcAAAAAAADwBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAB3BwAAAAAAAP8GAAAAAAAAew8AAAAAAAD/D3gAwsB4fP8P/IDHwP5+/w/+wOfh//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM4wxjnP5wAA/KDH8/9+AAB4gAPAQAg="},{"view":1,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"/AcAAAAAAADwBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2BgAAAAAAAPYGAAAAAAAAcgYAAAAAAAD/D3gAgMB4fP8P/IDHwPx+/w/8gMfg//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM4wwinP5wAA/IDH4/1+AAB4gAPAAAA="},{"view":2,"source":"579C9413-7DFE-4FAB-95CA-5797322EF26E.jpeg","bits":"/AcAAAAAAADwBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2BgAAAAAAAPYGAAAAAAAAcgYAAAAAAAD/B3gAgMB4fP8P/IDHwPx+/w/8gMfg//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM4wwinPxwAA/IDH4/1+AAB4gAPAAAA="},{"view":0,"source":"field1502","bits":"/gMAAAAAAAD4AwAAAAAAAP4DAAAAAAAw+AMAAAAAAPD4DwAA8B/g//9/AP7////////n////////////////////////////////////////////////////////////////////////////////////////////////////AwA="},{"view":1,"source":"field1502","bits":"/gMAAAAAAAD4AwAAAAAAAPgDAAAAAAAA+AMAAAAAAPD4AwAA8AcA+P5/AP7////////n/v///////////////////////////////////////////////////////////////////////////////////////5/B////////AQA="},{"view":2,"source":"field1502","bits":"+AMAAAAAAAD4AwAAAAAAAPgDAAAAAAAA+AMAAAAAAPD4AwAA8AEA8P4/AP7////////n/v///////////////////////////////////////////////////////////////////////////////////////5/B////////AQA="},{"view":0,"source":"field1503","bits":"fgAA/gDg/wD/BwD+BmD+A/9/+P9//v8D/////////wAH/v8B//8BAAH+/wH/fwAwAP7/Af9/ADAA/v8B/38AMAH+/wH/fwAwAP7/Af9/APwB/v8B/38A/AH+/wH/fwA8Af7/Af9/ADMB/v8B/38AA+D/n/P///8/4H9g/H/+/z8="},{"view":1,"source":"field1503","bits":"AAAAPAAA4ABgBgA+AGAAA/8f4P8ffgAA////////HwAH/v8B//8BAAD+/wH/fwAAAP6fAf9/AAAA/p8B/38AMAH+/wH/fwAwAP7/Af5/ADAB/v8B/n8A8AH+fwD/fwAAAP4fAP5/AAAA/h8A/n8AA4D/B8D///8PgH8A8H/+/z8="},{"view":2,"source":"field1503","bits":"AAAAPAAAgANgBgA+AIABDP8f4P9/+AEA////////fwAH/v8B/v8HAAD+/wH+/wEAAP6fAf7/AQAA/p8B/v8BwAD+/wH+/wHAAP7/Afj/AcAA/v8B+P8BwAH+fwD+/wEAAP4fAPj/AQAA/h8A+P8BDID/B8D///8/gH8A8P/5//8="},{"view":0,"source":"68DB3B38-real-004","bits":"AAAAAAD///8AAAAAAP///wAAAAAA////AAAAAAD///8AAAD//////wAAAP//////AAAA/////////////////////////////////////wD/////////AP////////8A////////////////////AP////////8A//////////8="},{"view":1,"source":"68DB3B38-real-004","bits":"AAAAAAAAAP8AAAAAAP///wAAAAAA////AAAAAAD///8AAAD//////wAAAAAA////AAAAAAD///8A/////////wD/////////AP///////wAA////////AP////////8A////////////////////AP////////8A//////////8="},{"view":2,"source":"68DB3B38-real-004","bits":"AAAAAAAAAP8AAAAAAP///wAAAAAA////AAAAAAD///8AAAD//////wAAAAAA////AAAAAAD///8A/////////wD/////////AP///////wAA////////AP////////8A////////////////////AP////////8A//////////8="},{"view":0,"source":"r4-new-0010-0005","bits":"////fwYeP8C83394HoAwwAzef3gegDzADAZ/eB4BPPAMwB94HgE88AzAf3geADzwDMB/eB4APPAM2H/4PwE8AAz+f/7/ATzADN5//v8BPAAM3n/+/wE8APz////f/zAAwP/+//8fDADDH/h/wAcAAPwf4H8AfwAAAAYAAAAAAAA="},{"view":1,"source":"r4-new-0010-0005","bits":"///zPwAAAMDP9zAMAwAwwAPxMwwPADDAA8A/DA8AMPADwA8MDwAw8APADwwPADDwA8APPA8AMPAA8D/+DwAwAADwP/4PADAAAPc8/Q8AMAAA9zz8DwAwAPz38D/PDzAA8D////8DAADAB8AzwAMAAMAHwDPAAwAA8AfwDwAPAAA="},{"view":2,"source":"r4-new-0010-0005","bits":"///zPwAAAMAP9zAMAwAwwAPxMwwPADDAA8A/DA8AMMADwA8MDwAwwAPADwwPADDAA8APPA8AMPAA8D/+DwAwAADwP/4PADAAAPcM/A8AMAAA9zz8DwAwAPz38D/PDzAA8D////8DAADAB8AzwAMAAMAHwDPAAwAA8AfwDwAPAAA="},{"view":0,"source":"field16-0010-0005","bits":"LwAAAAAAAOA/AAAAAAAAYC8AAAAAAADgBwAAAAAAAOAnAAAAAAAA4C8AAAAAAADgJwAAAAAAAOAvAAAAAAAA4C8AAAAAAADgDwAAAAAAAOA3AAAAAAAA4C8AAAAAAABgPwAAAAAAAOAnAAAAAAAAYCcAAAAAAABgNwAAAAAAAGA="},{"view":1,"source":"field16-0010-0005","bits":"JwAAAAAAAOA3AAAAAAAAYC8AAAAAAADgBwAAAAAAAOAnAAAAAAAA4C8AAAAAAADgBwAAAAAAAOAvAAAAAAAA4CcAAAAAAADgDwAAAAAAAOA3AAAAAAAA4C8AAAAAAABgNwAAAAAAAOAnAAAAAAAAYCcAAAAAAABgJwAAAAAAAGA="},{"view":2,"source":"field16-0010-0005","bits":"JwAAAAAAAOAnAAAAAAAAYAcAAAAAAADgBwAAAAAAAOAnAAAAAAAAYC8AAAAAAADgBwAAAAAAAOAvAAAAAAAA4CcAAAAAAADgBwAAAAAAAOA3AAAAAAAA4C8AAAAAAABgJwAAAAAAAOAnAAAAAAAAYCcAAAAAAABgJwAAAAAAAGA="},{"view":0,"source":"r4-new-0040","bits":"AAAAAMADAAAAAAAA/AAAwDAAAM//8x/w8wD8///P//PzAPz//8//8/8AD////H/w/wAD/z/8//D/AAP/P/z/APMwD/8//P8A8zAP/z/8/wDwMA//P/z/APAwA/9//O8A8DAD/3/87wDwMA//PzxjAPAwPPP/P+A/wAEDP8A/AAA="},{"view":1,"source":"r4-new-0040","bits":"AAAAAIADAAAAAAAADAAAwDAAAMxPMA/A8ADw8//P7zDwAPDz/8/vMPMAAP//zH8w8wAD/D/A/wDzAAP/P8B/APMAD/8//H8A8wAP/z/8fwAwMA//P/zvAPAwAPB//O8A8DAA8H/87wDwAADzDwxgAMAADPDwD+ADAAAAPIAzAAA="},{"view":2,"source":"r4-new-0040","bits":"AAAAAIADAAAAAAAADAAAwDAAAMxPMA/A8ADw8//P7zDwAPDz/8/vMPMAAP8/zH8w8wAD/D/AfwDzAAP/P8B/APMAD/8//H8A8wAP/z/8fwAwMA//P/zvAPAwAPB//O8A8DAA8H/87wDwAADzDwxgAMAADPDwD+ADAAAAPIAzAAA="},{"view":0,"source":"r6-green-dec","bits":"ABgAAMAfAAD8fwAA/B8AYPx/AAD8HwBg/38AAPx/APw8YQAA/B8D/DxgAIC/AQP8PGAAgL8BA/wweAKAPwAD/AAAAuAPAAP8MAAAgD8AA+QwAACAPwAD5DAAAIA/gA/gPAAAgD8AD+D/AAAAPIAP/DwAAAB8+A/88H4AAPz/D/w="},{"view":1,"source":"r6-green-dec","bits":"AAAAAMAHAADMfgAAzAcAAMx+AADMBwAA/34AAPwfAOAwYQAA/B8A5DBgAAA8AADkMGAAADwAAOQwAACAPwAD5AAAAIAPAAPgMAAAgD8AA+AwAACAPwAD4DAAAIA/AA/gMAAAADwAD+AwAAAAPAAP4DAAAAAMAA/k8BgAAHD+A/w="},{"view":2,"source":"r6-green-dec","bits":"AAAAAMAHAADMfgAAzAcAAMx+AADMBwAA/34AAPwfAOAwYAAAvB8A5ABgAAA8AABkAGAAADwAAGQwAACAPwAD5AAAAIAPAAPgAAAAgD8AA+AAAACAPwAD4DAAAIA/AA/gMAAAADwAA+AwAAAAPAAP4DAAAAAMAA/k8BgAAHD+A/w="},{"view":0,"source":"r6-blue-dec","bits":"////PwE/B+AD9x84B8AY4AP3HzgHwB7gA/cfOAfAHuAD9x84xwAe4AP3Hz7HAB74A/Ef/t8AGOAD95//3wAYgAP3n//fABiAA/cf/v8AGOAD95//58AYgPA/////Dx4A8Af4PyADAADwB/g/IAMAAPwB+D/APwAAAAEABgAAAAA="},{"view":1,"source":"r6-blue-dec","bits":"//f4HwAAAOAD9xg4AQAY4AP3GzgBABjgA/cbOAEAGOAA9xs4xwAY4AD3Hz7HABjgA/AfOAcAGIAD8Ac+xwAYgAPwBz7HABiAA/EfPscAGOAD95s/xwAYgMA+5/85AwYA8AYAJiAAAADwBgAmIAAAAPAB+D/ADwAAAAEAAAAAAAA="},{"view":2,"source":"r6-blue-dec","bits":"//f4HwAAAOAD9hg4AQAY4AP2GDgBABjgA/cbOAEAGOAA9wM4xwAY4AD3HzgHABjgAPAHPgcAGOAD8B84BwAAgAPwBz7HABiAA/EHPscAGOAD95s5BwAYgAP3mzkHABiAwD7n/zkDBgDwBgAmIAAAAPAGACYgAAAA8AH4P8APAAA="},{"view":0,"source":"r7-white-020-010","bits":"/A/g/wD+AwD/D/j/wP8DAP9//v/30R8A/3/8zv8hHwAH8D8A/wEcAAfwPwD7ARwAA3A/AP8BPAAD8D8A/wE80AP4PwD/ATzwA/g/AP8BPPgH8D8A9wE8gAfwPwD3ATwAB3D8j88BGAD/f/z/ixMcAP8/wP8B/gMA/B/A/wD+AwA="},{"view":1,"source":"r7-white-020-010","bits":"/A/g/wD+AwD+D/j/gP8DAP9/fv/30R8A53P8xP8BDwAD8D8A9wEcAAPwPwD7ARwAA3A/AP8BPAAD8D8A9wE80APwPwD/ATzwA/A/APsBPPAH8D8A8wE8gAfwPwDnARwAB3C8j8sBAADPffz/iwMIAP8PwP8B/gMA+B/A/wAcAwA="},{"view":2,"source":"r7-white-020-010","bits":"/A/g/wD+AwD+D/j/AP8DAP9/fu/3UR8A53P8xP8BDwADcD8A8wEcAAPwPwD7ARwAA3A/AP8BPAAD8D8A9wE80APwPwD3ATzwA/A/APsBPPAH8D8A8wE8gAfwPwDnARwAB3C8j8sBAADPffzfiwEIAP4PwP8B/gMA+B/A/wAcAwA="},{"view":0,"source":"r7-yellow-040","bits":"AAAAJAAAEADADwD/ANgHAMg/wP/D3x8AfPw+iPcFHgAu8H6A/wU4AC7wfoH/BXgAL/B/gf8FOAAv8H+B/wE44A/wf4D/BTj4L+B/Af8HePgP4H8B/wV4AA/gfwHPAXAAf8B9jY8HPAD8n8D/B/gfAPgfAP8A8AMAAAAAPABgAAA="},{"view":1,"source":"r7-yellow-040","bits":"AAAAAAAAEADABwD/AIAHAMA/wP/D2x8ALPg+iPcFHgAO8H4A9wU4AA7wfgH/AXgADvB/gf8BOAAO4H+B/wE44A7gfwD/BTjwDuB/Af8DeMAO4H8A/wV4AA/AfwDPAXAAOoB9jQ8DGAD4n4D/BrAfANAeAP4A8AMAAAAADAAAAAA="},{"view":2,"source":"r7-yellow-040","bits":"AAAAAAAAEADABwD/AIAHAMAfwP+D2x8ALPg+iPcFHgAO8H4A9wU4AA7wfgH/AXgADvB/gf8BOAAO4H+B/wE44A7gfwD/BTjwDuB/Af8DeMAO4H8A/wV4AA/AfwDPAXAAGoB9jQ8DGAD4n4D/BrAfANAeAP4A8AMAAAAADAAAAAA="},{"view":0,"source":"r7-orange-010-005","bits":"/vf9+8//fwA/wH8A/z/8AB+AfwD/N/gAf4B/Af8H8AB/gH8A7wdwAX+AfwH+B/DBP8B/Af4HcPE/wH8A7g9w8T/AfwHuB3DxP8B/AewH4AH+wHkB6DdwAP7DYQHoP/gA/P+A/o//fwDwPwD+APwHAGA7AN4A+AcAAAEAAACABgA="},{"view":1,"source":"r7-orange-010-005","bits":"/vfx+8//fwAfgH8A/zfwAB+AfwD/N/AAf4B/AO8H4AA/gH0A7gdwAT+AfwH+B+CBHsB9Af4HcPEewH8A7Adg8R7AfwHsB2DwHsB/AegHYAD+gGkB6DdwAHyBQQGIP3gA/H+ALo//fwDgPwCuAPwDAGA7AMwA+AcAAAAAAACABgA="},{"view":2,"source":"r7-orange-010-005","bits":"/vfx+8//fwAfgH8A/zfwAB+AfwD/N3AAf4B/AO8H4AA/gH0A7gdwAT+AfQH+B2CBHsB9Ae4HcPEewH8A7Adg8R7AfwDsB2DwHsB/AegHYAB+gGkB6DdwAHyBQQGIP3gA/H+ALo//fwDgPwCuAPwDAGAzAMwA+AcAAAAAAACABgA="},{"view":0,"source":"r7-red-020-010","bits":"AB5A/wD4AQAAfnj/Af8PAPj//v8D/w8AhP2/zOMlHwAG/L/E/6UfAAb8P8D3IR8ABvg/wPchH4AG+D/A8wEf+Af4f4D/AR/wD/g/wPchHvgP8H/A9yEekA/wf8H3IR6ATvnvzeclH4D8/+H/g/8LALifwL+B+wMAgB4AvgD4AwA="},{"view":1,"source":"r7-red-020-010","bits":"AA9AfwD8AQBAP3D/AfwPAMh/8/4D/w8AAP6/5mMyDwAC/j/g9zIfAAP+P8DzIB8AA/w/wPMAH4AD/D/A8wAf+AP8f8D3AB/wB/g/wPcgHvAD8H/g9yAekAf4b+D3EB4AJPzv5gcyHwDc/wB/g/0LAMxPAN8B2QMAwA8AHwDYAgA="},{"view":2,"source":"r7-red-020-010","bits":"AA9AfwD8AQBAP3D/AfwPAMh/8/4D/w8AAPy/5mMyDwAC/D/g9zAfAAP+P8DzIB8AA/w/wPMAH4AD/D/A8wAf+AP8f8D3AB/wB/g/wPcgHvAD8H/g9yAekAf4b+D3EB4AJPzv5gcyHwDc/wB/g/0LAMxPAN8B2QMAwA8AHwDYAgA="},{"view":0,"source":"legacy1502-current","bits":"AAAAAAAAAOAAAAAAAAAA4AAAAAAAAADgAADAAQAMAOAeAP8BgP8H4J7//3/+/x/g////////f+D///////9/4P///////3/4////////4/n//7///wP4////D/7/A/z///8P+P/D///h/z/4/8P//+H////////5//////////k="},{"view":1,"source":"legacy1502-current","bits":"AAAAAAAAAIAAAAAAAAAAgAAAAAAAAACAAAAAAAAAAOAeAMABAP4H4B7A8wf4/x/g/v//////Y+D///////9j4P///////2Pg4f//////4+H//z/+/wPg////D/7/Afj/4f8P+P8D///g/w/4/8P//+H////////5/////////+E="},{"view":2,"source":"legacy1502-current","bits":"AAAAAAAAAIAAAAAAAAAAgAAAAAAAAACAAAAAAAAAAOAeAMABAP4H4B7A8wf4/x/g/v//////Y+D///////9jgP///////2Pg4f//////4+H//z/+/wPg////D/7/Afj/4f8P+P8D///g/w/4/8P//+H////////5////////f+A="},{"view":0,"source":"clean46-truth","bits":"fwAAAAAAAAD+DwAAAAAAAH8fAAAAAAAAnx8AAAAAAAD/GQAAAAAAAP8fAAI4HB4e/AcAH/wc//+OAYAzwhjj8/4BgDHGmOPzjAGAcM4Y4/P8AAA//Tx+v/4BAAAAAAAA/AEAAAAAAAD4AwAAAAAAAI4BAAAAAAAA/gMAAAAAAAA="},{"view":1,"source":"clean46-truth","bits":"fwAAAAAAAAD2BwAAAAAAAH8fAAAAAAAAnx8AAAAAAAD/GQAAAAAAAP8bAAIoHB4O/AcAD/gc/v+GAIAzgBjj8/4BgDECCOPzjAGAMMIY4/P8AAA//Bx+n/4BAAAAAAAA/AEAAAAAAAD4AwAAAAAAAI4BAAAAAAAA7gMAAAAAAAA="},{"view":2,"source":"clean46-truth","bits":"fwAAAAAAAAD2BwAAAAAAAH8eAAAAAAAAnx8AAAAAAAD/GQAAAAAAAP8bAAIoHB4O/AcAD/gc/r+GAIAxgBjj8f4BgCECCOPzjAGAIMIY4/P8AAA//Bx+n/4BAAAAAAAA+AEAAAAAAAD4AwAAAAAAAI4BAAAAAAAAzgMAAAAAAAA="}],"0.04000":[{"view":0,"source":"field1503","bits":"AQD+B/B/AAAH8P8f/x8AAP/8////fwAA//////8fAAD+/4H//wAAAPj/gf8/AAAA+P+B/z8AAAD4/4H/PwAY8Pj/gf8/ABjw+P+B/z8AHvD4/4H/P4Af8Pj/gf8/gB/w+P+B//+AHwD4/4H//4AfAP///////x8A/zP+////BwA="},{"view":1,"source":"field1503","bits":"AQD+B/AfAAAAAP4f/B8AAP/8////HwAA//////8AAAD+/4H/PwAAAPj/gf8/AAAA4P+B/w8AAAD4/4H/DwAAwPj/gf8PABjw+P+B/w8AHMD4/4H/DwAe8Pj/gf8PAB7A+P+B//+AHwD4/4H//4AfAP///////wcA/wD4f/+HBwA="},{"view":2,"source":"field1503","bits":"AQD+B/AfAAAAAP4f/B8AAP/8////HwAA//////8AAAD+/4H/PwAAAPj/gf8/AAAA4P+B/w8AAAD4/4H/DwAAwPj/gf8PABjw+P+B/w8AHMD4/4H/DwAe8Pj/gf8PAB7A+P+B//+AHwD4/4H//4AfAP///////wcA/wD4f/+HBwA="},{"view":0,"source":"68DB3B38-real-004","bits":"AAAAAAAAAIDiB4B5AHwAAO4yAP/JbQCAvn/49L8BAeAPcHyA/wEMwA/APAD/ASzgD8A/AP8BBMAPYD8A/wEE+A/gPwD/AQT4D+A/AP8BBPgP4D8A/wEEwA/gvwD/AwSA//D+9usnAID+N/D/wP0BgNwGwP9A/wGAAAAAAAAAAIA="},{"view":1,"source":"68DB3B38-real-004","bits":"AACAMABAAABgAgD5ACAAAP436P+/gQGAjwBogKsBAMAPADgA9gEMwA9ALAD/ASzAD0A/AP8BAMANYD8A/wEE8A9gPwD/AQTwD+A/AP8BBPAP4D8A/wEEwA9gvgD/AQCAD+C+AOsDAID/sfj3ywcAgPwGQL8A/QAAgAYAPwD/AQA="},{"view":2,"source":"68DB3B38-real-004","bits":"AACAMABAAABgAgD5ACAAAP436P+/gQGAjwAogKsBAMAPADgA9gEMwA9ALAD/ASzAD0A/AP8BAMANYD8A/wEE8A9gPwD/AQTwD+A/AP8BBPAP4D8A/wEEwA9gvgD/AQCAD+C+AOsDAID/Mfj3ywcAgPwGQL8A/QAAgAYAPwD/AQA="},{"view":0,"source":"r4-new-0040","bits":"AAAAAAAAAD4AAAAAAAAAPgDAAwwBAPD3AMADDAEA8PcgwAD+AXgC8OfjAP4BeALw588A/gH+D/b/74D/Af4D9v/vgP8B/gP2Py8A/gH4A/bnLwD+AfgD9j8vAP4BeALwJ8BAPgF4APAmwAAMGXgAAAAAAAAAngEAAAAAAAAGAAA="},{"view":1,"source":"r4-new-0040","bits":"AAAAAAAAADgAAAAAAAAAOAAAAAAAAID3IAAADgEYAPDnAAD+AXgC8OcAAP4BeALw5wAA/gF4DvDnAAD+AXgO8CcAAP4BeALwJyAAPgF4AvAnLAA+AXgC8CcsAD4BeALwAAAAPgF4AgAgAAAOAHgAACAAAAAAeAAAIAAAAAB4AAA="},{"view":2,"source":"r4-new-0040","bits":"AAAAAAAAADgAAAAAAAAAOAAAAAAAAID3IAAADgEYAPDnAAD+AXgC8OcAAP4BeALw5wAA/gF4DvDnAAD+AXgO8CcAAP4BeALwJyAAPgF4AvAnLAA+AXgC8CcsAD4BeALwAAAAPgF4AgAgAAAOAHgAACAAAAAAeAAAIAAAAAB4AAA="},{"view":0,"source":"r7-yellow-040","bits":"OAGABwA5AAD8A+ALAB0AAPgD4AsAXwAA+AfgCwB/AQAlzxUw3vADAAfcF7DfwAcAB/wXcP/ABwAH/AfgP8AHAAf8F8A/wAcAB/wXwL+ABwAF/A/gn4AH8AX8H+C/wAf4BfgH4D/AB/8F+AeAv8AP/AX4D4A/wA/9BfgPgD/AD/4="},{"view":1,"source":"r7-yellow-040","bits":"AAAABgAQAAD4A+ACABkAANgCYAMAHQAA2AJgCABdAQAFxxUQ3GADAAfcFQDfwAMAA/wXYH/AAwAB/AfAH8AHAAX8F4A/gAcABfwXgD+ABwAF+A/gH4AHsAX4H8A/gAe4BfgHwD+AB/gF+AeAP4AH+AX4D4A/gAf8BfgPgD+AB/g="},{"view":2,"source":"r7-yellow-040","bits":"AAAABgAQAAD4A+ACABkAANgCYAMAHQAA2AJgCABdAQABhxUQ3GADAAfcFQDfwAMAA/wXYH/AAwAB/AfAH8AHAAX8F4AfgAcABfwXgD+ABwAF+A/gH4AHsAX4H8A/gAe4BfgHwD+AA/gF+AeAP4AH+AX4D4A/gAf8BfgPgD+AB/g="}],"0.00500":[{"view":0,"source":"r4-new-0010-0005","bits":"/z8Y+P8ADMD/Pxj4/wAMwPw/H/j/AAzAgAEf+P8ADPIAxv/5/wAM8ADG//n/AAzwAN4f+P8AD/6A/x/4/4APAID/H/jfgA8A/P9/ft7/DwD8P///4f4PAPw////h/g8A/B/4f8D+AAD/B+AfAP8AADwAYAAAAAAAPABgAAAAAAA="},{"view":1,"source":"r4-new-0010-0005","bits":"/D8A+P8AAMD8PwD4/wAAwPwZGPj/AADAgAEfeP4AAPAAwP8Z3gAAwADA/xneAADAAN4fGN4ADPCA3x943oAMAID/H3jegA8A/P9hft7/DwDAP//54eYPAMA///nh5g8A/BkYYMDgAAD/B+AfAP8AADAAAAAAAAAAMAAAAAAAAAA="},{"view":2,"source":"r4-new-0010-0005","bits":"/D8A+P8AAMD8PwD4/wAAwPwZGPj/AADAgAEfeP4AAPAAwB8Y3gAAwADAHxjeAADAAN4fGN4ADPCA3x943oAMAAD+H3jegA8A/P8Bft7/DwDAP/754eYPAMA//vnh5g8A/BkAYMDgAAD/B+AfAP8AADAAAAAAAAAAMAAAAAAAAAA="},{"view":0,"source":"field16-0010-0005","bits":"DwAAAABgD7AvAAAAAPgP+D4AAAAAfgcfPgAAAAB+Ag88AAAAAP4ADzAAAAAA/gsPMAAAAAD+gwcwAAAAAACCBzAAAAAAAPgHHAAAAAAA/AcYAAAAAAB4FxwAAAAAILwHHgAAAAAgHpcfAAAAwP8f9g8AAADA/0/wDwAAAIBvAzA="},{"view":1,"source":"field16-0010-0005","bits":"BwAAAABgD7AvAAAAAPgP4D4AAAAAfgMfPAAAAAB+Ag88AAAAAP4ABzAAAAAA/gMHMAAAAAD+AwcwAAAAAACCBzAAAAAAAPgHEAAAAAAA2AcQAAAAAAB4FxgAAAAAILwHHAAAAAAgHhcfAAAAgP8f9g8AAACA/wvwDwAAAIBvAzA="},{"view":2,"source":"field16-0010-0005","bits":"BgAAAABgD7AvAAAAAPgP4D4AAAAAPgMfPAAAAAA+Ag88AAAAAP4ABzAAAAAA/gIHMAAAAABuAwcwAAAAAAACBzAAAAAAALgHEAAAAAAAmAcQAAAAAAB4FxgAAAAAILwHHAAAAAAgHhcfAAAAgP8ftg8AAACA/wvwDwAAAIBvAzA="},{"view":0,"source":"r6-blue-dec","bits":"////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AAD///////8AAP///////wAA////////AAA="},{"view":1,"source":"r6-blue-dec","bits":"//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8="},{"view":2,"source":"r6-blue-dec","bits":"//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8="},{"view":0,"source":"r7-orange-010-005","bits":"wC/zN5//PgCED/AD/gu8gYUP8Af+C7yBhyHwB/4LvIEHQPgH/gu4sQeA+wb+C/jxBoD3Av8LvP0GgP8C/gv8kQaA/wL+C7wB/t//6/cvvAH4f8D/Af8/APh/AP8B9gMAACwAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA="},{"view":1,"source":"r7-orange-010-005","bits":"wC/zN4//PgCED/AD/gu8AQQP8AP8C7wBBQPgB/wLvIEHAPAH/gu8oQdA+Af+C7ixB4D7Bv4LuPEGgPcC/gu89QaA/wL/A7zwBID/Av4LvAEWAP8D/w+8AXwW/+vXD7wB+H/A/QE3PwDwfwD9AdIDANA/APQAAgMAAAwAAAAAAAA="},{"view":2,"source":"r7-orange-010-005","bits":"wC/zN4//PgCED/AD/gu8AQQP8AP8C7wBBQPgB/wLvIEHAPAH/gu8oQdA+Ab+C7ixBoD7Bv4LuPEEgPcC/gu89QaA/wL/A7zwBID/Av4LvAEWAP8D/w+8AXwW/wPXD7wA+H/A/QE3HwDwfwD9AdIDANA/APQAAgMAAAwAAAAAAAA="},{"view":0,"source":"r7-blue-010-005","bits":"px////D/A8AA/wf4OAAHwAH/D/g5AAfAAf8H/HwAA8AB/wf8PQAD8ADfB/w/AAP8Ad8P/D8AA/gBvwf8fwAD+AE/B/w/AAfAAT8P/D4AA4D9P/7v/vsDgPwB/F/w+wAArgO4D8B/AICAAQAAAAQAgAAAAAAAAACAAAAAAAAAAIA="},{"view":1,"source":"r7-blue-010-005","bits":"px////D/A8AAfwf4EAADwAD+B/g4AAPAAf8H+DUAAsAA3gf8OQAD4ADeB/w9AAP4Ad4H+D0AA/gBvgf8PQAD+AG+B/x/AAP4AB4H/D8AA4ABPg/8PgADgP0//u/++QGA/AD8V/D7AAD8APgHwH8AAIIBsASAbQCAAAAAAAAAAIA="},{"view":2,"source":"r7-blue-010-005","bits":"ph///fDvA8AAfwf4EAADwAD+B/g4AAPAAf8H+DQAAsAA3gf8OQAD4ADeB/w8AAP4AN4H+D0AA/gBngf8PAAD+AC+B/x/AAP4AB4H+D4AA4ABPg/8PgADgP0/vu/++QGA/AD8V/D7AAD8APgHwH8AAIABsACAbQCAAAAAAAAAAIA="},{"view":0,"source":"clean46-truth","bits":"BweI//H9cfwHB4j/8f1x/AcPiP/xgX/8Bw+I//GBf/wHD4j/8YH//AcPiP/xgf/8Bw+O//GBf/AHD47/8YF/8AcPjv/xgX/wBw+O//GBf/D/R/j///////9H+P///////rH5/3/+4x/+sfn/f/7jH/7B8YM//oEP/sHxgz/+gQ8="},{"view":1,"source":"clean46-truth","bits":"BweI//F9cPwHB4j/8X1w/AcPiP/xgX/8Bw+I//GBf/wHD4j/8YH//AcPiP/xgf/8Bw+I//GBf/AHD4j/8YF/8AYPjv/xgX/wBg+O//GBf/D+R/j/////f/5H+P////9//gHIz3/+4x/+AcjPf/7jH/6BwYM//oEP/oHBgz/+gQ8="},{"view":2,"source":"clean46-truth","bits":"BweI//F9cPwHB4j/8X1w/AcPiP/xgX/8Bw+I//GBf/wHD4j/8YH//AcPiP/xgf/8Bw8I/vGBf/AHDwj+8YF/8AYPDv7xgX/wBg8O/vGBf/D+R/j/////f/5H+P////9//gHIz3/+4x/+AcjPf/7jH/6BwYM//oEP/oHBgz/+gQ8="}]}};

},
'core_v2_trace17_continuity_path.js': function(module,exports,require){
'use strict';
const geom=require('./core_v2_geometry6.js');
const SAFETY=Object.freeze({
  lowPersistenceMin:.24,
  lowGridLeakMaxForWeak:.25,
  highXSpanMin:.40,
  highClusterRateMaxForNarrow:.12,
  acceptedXMinSpan:.72,
  acceptedXMaxGap:.24,
  acceptedYMaxRangeSteps:2.25,
  acceptedYMaxDeviationSteps:1.75,
  acceptedYMaxSegmentSpanSteps:1.60,
  affineBelowVisibleSteps:1.75,
  affineAboveVisibleSteps:1.25,
  jointHueMax:42,
  distinctCenterMin:.50,
  distinctMedianMin:.50,
  distinctValidationMin:.20,
  samplingMaxStepSpan:.50,
  samplingHueDriftMax:30
});
const median=a=>{if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN;
const mad=a=>{const m=median(a);return median(a.map(v=>Math.abs(v-m)))};
function rgb2hue(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;if(!d)return 0;let h;if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);return(h+360)%360}
function stat(r,g,b){const mx=Math.max(r,g,b),mn=Math.min(r,g,b);return{lum:.299*r+.587*g+.114*b,sat:(mx-mn)/Math.max(1,mx),h:rgb2hue(r,g,b)}}
function hd(a,b){let d=Math.abs(a-b)%360;return Math.min(d,360-d)}
function sample(img,x,y){x=Math.max(0,Math.min(img.width-1,Math.round(x)));y=Math.max(0,Math.min(img.height-1,Math.round(y)));const i=(y*img.width+x)*4;return[img.data[i],img.data[i+1],img.data[i+2]]}
function normalizePlot(plot){let v=[...plot.v].sort((a,b)=>a-b),st=plot.vStep;while(v.length<11&&st>0){let l=v[0]-st,r=v.at(-1)+st,cl=l>=plot.box.left-2,cr=r<=plot.box.right+2;if(!cl&&!cr)break;if(cr&&(!cl||(plot.box.right-v.at(-1))>=(v[0]-plot.box.left)))v.push(r);else v.unshift(l)}if(v.length>11){let bc=(plot.box.left+plot.box.right)/2,b=v.slice(0,11),bs=1e9;for(let i=0;i<=v.length-11;i++){let w=v.slice(i,i+11),s=Math.abs((w[0]+w[10])/2-bc);if(s<bs){bs=s;b=w}}v=b}const top=Math.max(plot.box.top,plot.h[0]-plot.hStep*.65),bottom=Math.min(plot.box.bottom,plot.h.at(-1)+plot.hStep*.85);return{...plot,v,left:v[0],right:v.at(-1),top,bottom}}
function canonical(img,p,W=500,H=240){const d=new Uint8Array(W*H*4);for(let y=0;y<H;y++){let sy=p.top+y/(H-1)*(p.bottom-p.top);for(let x=0;x<W;x++){let sx=p.left+x/(W-1)*(p.right-p.left),q=sample(img,sx,sy),i=(y*W+x)*4;d[i]=q[0];d[i+1]=q[1];d[i+2]=q[2];d[i+3]=255}}return{data:d,width:W,height:H,h:p.h.map(y=>(y-p.top)/(p.bottom-p.top)*(H-1)),v:p.v.map(x=>(x-p.left)/(p.right-p.left)*(W-1))}}
function near(z,a,t){for(const q of a)if(Math.abs(z-q)<=t)return true;return false}

function enumerateForeground(c,a,b){
  const W=c.width,H=c.height,x0=Math.max(3,Math.floor(a/500*(W-1))),x1=Math.min(W-4,Math.ceil(b/500*(W-1)));
  const hist=new Array(72).fill(0);let white=0;
  for(let y=4;y<H-4;y++)for(let x=x0;x<=x1;x++){
    if(near(x,c.v,4.5)||near(y,c.h,4.5))continue;
    const i=(y*W+x)*4,s=stat(c.data[i],c.data[i+1],c.data[i+2]);
    if(s.lum<38)continue;
    if(s.sat>.14)hist[Math.floor(s.h/5)%72]++; else if(s.lum>138)white++;
  }
  const cand=hist.map((n,i)=>({mode:'color',hue:i*5+2.5,n})).filter(q=>q.n>3).sort((a,b)=>b.n-a.n).slice(0,8);
  if(white>3)cand.push({mode:'white',hue:0,n:white});
  return cand;
}
function pixelMatches(c,x,y,f){
  const i=(y*c.width+x)*4,s=stat(c.data[i],c.data[i+1],c.data[i+2]);
  return f.mode==='white'?(s.sat<.28&&s.lum>132):(s.sat>.10&&s.lum>36&&hd(s.h,f.hue)<27);
}
function clusterRows(ys){
  if(!ys.length)return[];
  const a=[...ys].sort((x,y)=>x-y),groups=[];let g=[a[0]];
  for(let i=1;i<a.length;i++){
    // A photographed trace is several pixels thick. Keep neighboring antialiased rows
    // in one vertical component, but do not merge a second trace/outlier population.
    if(a[i]-a[i-1]<=2)g.push(a[i]); else {groups.push(g);g=[a[i]];}
  }
  groups.push(g);
  return groups.map(v=>({y:median(v),n:v.length,y0:v[0],y1:v.at(-1),thickness:v.at(-1)-v[0]+1}));
}
function continuityPath(columns,H){
  // r17: choose exactly one trace center for each occupied X bin by global continuity.
  // Previous code took the median of *all* same-colour pixels in a column. On decimal
  // plots that can jump between a dense baseline and sparse high outliers. Here each
  // vertical component is a candidate and dynamic programming chooses the persistent
  // geometric path. This changes pixel selection, never the pixel->value calibration.
  const states=[];
  for(let ci=0;ci<columns.length;ci++){
    const col=columns[ci],cur=[];
    for(let k=0;k<col.clusters.length;k++){
      const q=col.clusters[k],pathPenalty=Number(q.pathPenalty)||0;let best={score:2.0+Math.min(2.4,Math.log1p(q.n)*.75)-pathPenalty,prev:null};
      for(let pj=Math.max(0,states.length-4);pj<states.length;pj++){
        const prevCol=states[pj]; if(!prevCol?.length)continue;
        const gap=Math.max(1,col.bi-columns[pj].bi); if(gap>4)continue;
        for(let pi=0;pi<prevCol.length;pi++){
          const p=prevCol[pi],dy=Math.abs(q.y-p.y)/Math.max(1,H);
          // Reward persistence and local pixel support. Penalize large vertical jumps,
          // but allow genuine gradual/high-band movement and short missing-bin gaps.
          const transition=2.35 - Math.min(5.5,dy*18/Math.sqrt(gap)) - .22*(gap-1);
          const support=Math.min(2.4,Math.log1p(q.n)*.75);
          const score=p.score+transition+support-pathPenalty;
          if(score>best.score)best={score,prev:{ci:pj,pi}};
        }
      }
      cur.push({...q,score:best.score,prev:best.prev});
    }
    states.push(cur);
  }
  let end=null;
  for(let ci=0;ci<states.length;ci++)for(let pi=0;pi<states[ci].length;pi++){
    const q=states[ci][pi]; if(!end||q.score>end.score)end={ci,pi,score:q.score};
  }
  if(!end)return[];
  const picked=[];let at=end;
  while(at){const q=states[at.ci][at.pi],col=columns[at.ci];picked.push({bi:col.bi,xv:col.xv,y:q.y,n:q.n,clusterThickness:q.thickness,clusterY0:q.y0,clusterY1:q.y1});at=q.prev;}
  picked.reverse();
  return picked;
}
function candidateSeries(c,f,a,b){
  const W=c.width,H=c.height,bins=61,columns=[],counts=[];let hit=0,dense=0,total=0,gridLeak=0;
  for(let bi=0;bi<bins;bi++){
    const xv=a+(bi+.5)*(b-a)/bins,x=Math.round(xv/500*(W-1)),ys=[];
    for(let xx=Math.max(2,x-1);xx<=Math.min(W-3,x+1);xx++)for(let y=4;y<H-4;y++){
      if(Number.isFinite(c.energyMaxY)&&y>c.energyMaxY)continue;
      if(near(xx,c.v,3.0)||near(y,c.h,3.0))continue;
      if(pixelMatches(c,xx,y,f))ys.push(y);
    }
    counts.push(ys.length);
    const greenFamily=!!c.gridPathPenaltyEnabled&&f.mode==='color'&&f.hue>72&&f.hue<166;
    const clusters=clusterRows(ys).filter(q=>q.n>=1).map(q=>{
      // r25-dev57 reconstruction of the dev46 grid-likeness path penalty.
      // Grid/moire aliases often survive the nominal +/-3 px exclusion by only a few pixels.
      // Penalize a green candidate while it dwells near a known physical horizontal grid row;
      // this changes path selection only and never the pixel->value calibration.
      let gridDist=Infinity;
      for(const gy of (c.h||[]))gridDist=Math.min(gridDist,Math.abs(q.y-gy));
      const gridLike=greenFamily&&gridDist<11;
      const pathPenalty=gridLike?2.8*(1-gridDist/11):0;
      return {...q,gridDist,pathPenalty};
    });
    columns.push({bi,xv,clusters});
  }
  const series=continuityPath(columns,H);
  const byBin=new Map(series.map(q=>[q.bi,q]));
  for(let bi=0;bi<bins;bi++){
    const q=byBin.get(bi); if(!q)continue;
    hit++;total+=Math.min(16,q.n);if(q.n>=3)dense++;if(near(q.y,c.h,8.5))gridLeak++;
  }
  const occupied=series.map(q=>q.bi), gaps=[];for(let i=1;i<occupied.length;i++)gaps.push(occupied[i]-occupied[i-1]);
  let longest=0,cur=0,last=-99;for(const bi of occupied){if(bi-last<=2)cur++;else cur=1;longest=Math.max(longest,cur);last=bi}
  const longestRunFrac=longest/bins;
  const isolatedFrac=occupied.length?occupied.filter((bi,i)=>{const prev=i?bi-occupied[i-1]:99,next=i+1<occupied.length?occupied[i+1]-bi:99;return prev>2&&next>2}).length/occupied.length:1;
  const xSpanFrac=occupied.length>1?(occupied[occupied.length-1]-occupied[0]+1)/bins:0;
  let clusters=0,lastCluster=-99;for(const bi of occupied){if(bi-lastCluster>2)clusters++;lastCluster=bi}
  const clusterRate=occupied.length?clusters/occupied.length:1;
  return {series,counts,coverage:hit/bins,denseCoverage:dense/bins,avgDensity:total/bins,gridLeakFrac:hit?gridLeak/hit:1,longestRunFrac,isolatedFrac,xSpanFrac,clusterRate,pathMode:'one-center-per-x-continuity'};
}


function continuityScore(series,H){
  if(series.length<3)return -2;
  const dy=[];for(let i=1;i<series.length;i++){let gap=series[i].bi-series[i-1].bi;if(gap<=3)dy.push(Math.abs(series[i].y-series[i-1].y)/Math.max(1,gap));}
  const jump=dy.length?median(dy)/H:1;
  const ys=series.map(q=>q.y),spread=(mad(ys)||0)/H;
  return 1.15-Math.min(1.0,jump*5.0)-Math.min(.55,spread*.6);
}
function scoreRangeCandidate(c,f,a,b,kind){
  const q=candidateSeries(c,f,a,b),green=f.mode==='color'&&f.hue>72&&f.hue<166;
  const cont=continuityScore(q.series,c.height);
  // Low is normally a continuous baseline, High can be a cloud but still spans the requested X range.
  let score = q.coverage*(kind==='low'?7.0:4.7) + q.denseCoverage*(kind==='low'?2.2:3.5)
            + Math.min(1.5,q.avgDensity*.10) + cont*(kind==='low'?1.8:.8)
            + Math.log1p(f.n)*.014;
  // Residual grid-green is the principal false population. Penalize only when it sits close to grid rows.
  if(green) score -= q.gridLeakFrac*3.0;
  // Low should behave like a horizontally persistent baseline. Short text/marker clusters
  // can have high local density but do not persist across X.
  if(kind==='low'){
    score += Math.min(1.2,q.longestRunFrac*2.0);
    score -= q.isolatedFrac*1.4;
    if(q.longestRunFrac<.18)score-=1.2;
  }else{
    // High may legitimately vary, so do not demand a long baseline. Instead require
    // broad X support and penalize fragmented text/marker-like populations.
    score += Math.min(0.9,q.xSpanFrac*0.9);
    score -= q.clusterRate*1.0;
    score -= q.isolatedFrac*0.8;
    if(q.xSpanFrac<.45)score-=1.0;
  }
  // Reject sparse accidental text / marker populations.
  if(q.coverage<.08) score-=3.0;
  return {...f,...q,continuity:cont,score};
}
function chooseRangeForeground(c,a,b,kind){
  const cand=enumerateForeground(c,a,b).map(f=>scoreRangeCandidate(c,f,a,b,kind)).sort((x,y)=>y.score-x.score);
  if(!cand.length||cand[0].coverage<.10)throw Error(`Foreground population unresolved in ${kind} range.`);
  return {best:cand[0],candidates:cand.slice(0,6)};
}
function valuesFromSeries(series,c,scale){
  const vals=[];for(const q of series){let oy=scale._top+q.y/(c.height-1)*(scale._bottom-scale._top);vals.push(scale.slope*oy+scale.intercept)}return vals;
}
function robustAccepted(v,step,series=null,opt={}){
  if(v.length<5)return{mean:mean(v),indices:v.map((_,i)=>i),values:[...v],rescuedRuns:[]};
  const hardMax=Number.isFinite(opt.hardMax)?opt.hardMax:Infinity,eligible=v.map(x=>Number.isFinite(x)&&x<=hardMax);
  const eligibleVals=v.filter((_,i)=>eligible[i]);if(!eligibleVals.length)return{mean:NaN,indices:[],values:[],rescuedRuns:[]};
  const m=median(eligibleVals),M=mad(eligibleVals)||Math.abs(step)*.04,t=Math.max(M*3.5,Math.abs(step)*.7),keep=new Set();
  for(let i=0;i<v.length;i++)if(eligible[i]&&Math.abs(v[i]-m)<=t)keep.add(i);
  const rescuedRuns=[];
  if(opt.sustainedRuns&&Array.isArray(series)&&series.length===v.length){
    let run=[];
    const flush=()=>{
      if(run.length>=4){
        run=run.filter(i=>eligible[i]);if(run.length<4){run=[];return}
        const rv=run.map(i=>v[i]),rm=median(rv),rM=mad(rv),range=Math.max(...rv)-Math.min(...rv);
        // Preserve a sustained alternate trace level (e.g. the 270–330 transition baseline)
        // only when it is internally tight. Isolated/irregular spikes remain rejected.
        const ref=Number.isFinite(opt.rescueReference)?opt.rescueReference:null;
        const nearRef=ref==null||Math.abs(rm-ref)<=Math.abs(step)*.45;
        if(rM<=Math.abs(step)*.16&&range<=Math.abs(step)*.55&&nearRef){
          for(const i of run)keep.add(i);
          rescuedRuns.push({start:run[0],end:run.at(-1),count:run.length,median:rm,mad:rM,range,reference:ref});
        }
      }
      run=[];
    };
    for(let i=0;i<v.length;i++){
      if(keep.has(i)){flush();continue}
      const contiguous=!run.length||((series[i]?.bi??i)-(series[run.at(-1)]?.bi??run.at(-1))<=2);
      if(!contiguous)flush();
      run.push(i);
    }
    flush();
  }
  const indices=[...keep].sort((a,b)=>a-b),fallback=v.map((_,i)=>i).filter(i=>eligible[i]),use=indices.length>=5?indices:fallback,values=use.map(i=>v[i]);
  return{mean:mean(values),indices:use,values,rescuedRuns};
}
function robust(v,step){return robustAccepted(v,step).mean}
function extractRangePopulation(c,scale,a,b,kind){
  const pick=chooseRangeForeground(c,a,b,kind),vals=valuesFromSeries(pick.best.series,c,scale);
  if(vals.length<10)throw Error(`Not enough population trace bins in ${kind} range.`);
  return {mean:robust(vals,scale.step),count:vals.length,foreground:{mode:pick.best.mode,hue:pick.best.hue,score:pick.best.score,coverage:pick.best.coverage,denseCoverage:pick.best.denseCoverage,gridLeakFrac:pick.best.gridLeakFrac,continuity:pick.best.continuity},candidates:pick.candidates.map(q=>({mode:q.mode,hue:q.hue,score:q.score,coverage:q.coverage,denseCoverage:q.denseCoverage,gridLeakFrac:q.gridLeakFrac}))};
}
function findPlot(img){return normalizePlot(geom.findPlot(img))}
function pairAffinity(a,b){
  if(a.mode==='white'&&b.mode==='white')return 4.0;
  if(a.mode!==b.mode)return -2.5;
  const d=hd(a.hue,b.hue);
  if(d<=7.5)return 4.0;
  if(d<=17.5)return 2.6;
  if(d<=30)return .7;
  return -Math.min(4.0,(d-30)/18);
}
function suppressLikelyWhiteUi(cands){
  const color=cands.find(q=>q.mode==='color'&&q.coverage>=.25&&q.denseCoverage>=.12);
  const white=cands.find(q=>q.mode==='white');
  if(!color||!white)return cands;
  // In non-white-dominant cases, a broad color population near the white score is more likely
  // to be the photographed trace while white is UI/text or desaturated moire.
  if(color.score>=white.score-.70)return cands.filter(q=>q.mode!=='white');
  return cands;
}

function suppressTopBorderWhite(cands,H){
  const white=cands.find(q=>q.mode==='white'),color=cands.find(q=>q.mode==='color'&&q.coverage>=.30&&q.xSpanFrac>=.80);
  if(!white||!color||!white.series?.length)return cands;
  const ym=median(white.series.map(q=>q.y));
  if(white.coverage>=.65&&ym<=H*.14)return cands.filter(q=>q.mode!=='white');
  return cands;
}
function dominantWhitePair(L,H){
  const lw=L.find(q=>q.mode==='white'),lc=L.find(q=>q.mode==='color');
  const hw=H.find(q=>q.mode==='white'),ht=H[0];
  if(!lw||!lc||!hw)return null;
  const lowStrong=lw.coverage>=.70&&lw.xSpanFrac>=.80&&lw.clusterRate<=.10&&(lw.score-lc.score)>=1.5;
  const highSupported=hw.coverage>=.70&&hw.xSpanFrac>=.80&&hw.clusterRate<=.10&&hw.score>=ht.score-.55;
  return lowStrong&&highSupported?{low:lw,high:hw}:null;
}
function acceptedDistributionUnsafe(e){return e.occupiedQuartiles<4||e.maxGapFrac>SAFETY.acceptedXMaxGap||e.xSpan<SAFETY.acceptedXMinSpan}
function acceptedYStats(samples,step,a,b){
  const vals=samples.map(s=>s.value).filter(Number.isFinite),m=median(vals),abs=vals.map(v=>Math.abs(v-m)),mad=median(abs);
  const sorted=[...vals].sort((x,y)=>x-y),q=(p)=>sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*p)))];
  const quartileMeans=[0,1,2,3].map(k=>{const v=samples.filter(s=>Math.min(3,Math.max(0,Math.floor((s.x-a)/Math.max(1,b-a)*4)))===k).map(s=>s.value);return v.length?v.reduce((x,y)=>x+y,0)/v.length:NaN});
  const finiteQ=quartileMeans.filter(Number.isFinite),segmentSpan=finiteQ.length?Math.max(...finiteQ)-Math.min(...finiteQ):Infinity;
  return {median:m,madStep:mad/step,iqrStep:(q(.75)-q(.25))/step,rangeStep:(Math.max(...vals)-Math.min(...vals))/step,maxDevStep:Math.max(...abs)/step,segmentMeans:quartileMeans,segmentSpanStep:segmentSpan/step};
}
function acceptedYUnsafe(s){
  // Reject only catastrophic post-filter vertical spread; normal Energy traces may legitimately slope or step.
  return !Number.isFinite(s.rangeStep)||s.rangeStep>SAFETY.acceptedYMaxRangeSteps||s.maxDevStep>SAFETY.acceptedYMaxDeviationSteps||s.segmentSpanStep>SAFETY.acceptedYMaxSegmentSpanSteps;
}
function affineTraceEnvelope(axis,samples){
  const labels=(axis?.values||[]).filter(Number.isFinite),step=Math.max(1e-12,Math.abs(axis?.step||0));
  if(!labels.length)return {accepted:false,reason:'no-axis-labels'};
  const lo=Math.min(...labels),hi=Math.max(...labels),vals=samples.map(s=>s.value).filter(Number.isFinite);
  if(!vals.length)return {accepted:false,reason:'no-trace-samples'};
  const mn=Math.min(...vals),mx=Math.max(...vals);
  const belowSteps=Math.max(0,(lo-mn)/step),aboveSteps=Math.max(0,(mx-hi)/step);
  return {accepted:belowSteps<=SAFETY.affineBelowVisibleSteps&&aboveSteps<=SAFETY.affineAboveVisibleSteps,belowSteps,aboveSteps,labelMin:lo,labelMax:hi,sampleMin:mn,sampleMax:mx};
}
function persistentBaselineContinuation(c,f,a,b,centerY,stepY){
  const W=c.width,H=c.height,bins=61,series=[];
  const tol=Math.max(4,Math.abs(stepY)*.42);
  for(let bi=0;bi<bins;bi++){
    const xv=a+(bi+.5)*(b-a)/bins,x=Math.round(xv/500*(W-1)),ys=[];
    for(let xx=Math.max(2,x-1);xx<=Math.min(W-3,x+1);xx++)for(let y=Math.max(4,Math.floor(centerY-tol));y<=Math.min(H-5,Math.ceil(centerY+tol));y++){
      if(Number.isFinite(c.energyMaxY)&&y>c.energyMaxY)continue;
      if(near(xx,c.v,3.0)||near(y,c.h,3.0))continue;
      if(pixelMatches(c,xx,y,f))ys.push(y);
    }
    const groups=clusterRows(ys); if(!groups.length)continue;
    groups.sort((q,r)=>Math.abs(q.y-centerY)-Math.abs(r.y-centerY)||r.n-q.n);
    const q=groups[0]; if(Math.abs(q.y-centerY)<=tol)series.push({bi,xv,y:q.y,n:q.n,clusterThickness:q.thickness});
  }
  if(!series.length)return{accepted:false,series:[],coverage:0,xSpanFrac:0};
  const occ=series.map(q=>q.bi),coverage=series.length/bins,xSpanFrac=occ.length>1?(occ.at(-1)-occ[0]+1)/bins:0;
  const ym=median(series.map(q=>q.y)),drift=Math.abs(ym-centerY)/Math.max(1,Math.abs(stepY));
  return{accepted:coverage>=.50&&xSpanFrac>=.72&&drift<=.30,series,coverage,xSpanFrac,medianY:ym,driftStep:drift,tolerancePx:tol};
}

function elevatedHighBranch(c,f,a,b,lowCenter,stepY){
  const W=c.width,H=c.height,bins=61,columns=[];
  const minSep=Math.max(4,Math.abs(stepY)*.28),maxSep=Math.max(minSep+4,Math.abs(stepY)*2.8);
  for(let bi=0;bi<bins;bi++){
    const xv=a+(bi+.5)*(b-a)/bins,x=Math.round(xv/500*(W-1)),ys=[];
    for(let xx=Math.max(2,x-1);xx<=Math.min(W-3,x+1);xx++)for(let y=4;y<H-4;y++){
      if(Number.isFinite(c.energyMaxY)&&y>c.energyMaxY)continue;
      if(near(xx,c.v,3.0)||near(y,c.h,3.0))continue;
      if(!pixelMatches(c,xx,y,f))continue;
      const sep=lowCenter-y;if(sep>=minSep&&sep<=maxSep)ys.push(y);
    }
    const clusters=clusterRows(ys).map(q=>{
      let gridDist=Infinity;for(const gy of (c.h||[]))gridDist=Math.min(gridDist,Math.abs(q.y-gy));
      const greenFamily=!!c.gridPathPenaltyEnabled&&f.mode==='color'&&f.hue>72&&f.hue<166;
      const pathPenalty=greenFamily&&gridDist<11?2.8*(1-gridDist/11):0;
      return {...q,gridDist,pathPenalty};
    });
    columns.push({bi,xv,clusters});
  }
  const series=continuityPath(columns,H);if(!series.length)return{accepted:false,series:[],coverage:0,xSpanFrac:0};
  const occ=series.map(q=>q.bi),coverage=series.length/bins,xSpanFrac=occ.length>1?(occ.at(-1)-occ[0]+1)/bins:0;
  let longest=0,cur=0,last=-99,gridLeak=0;for(const q of series){if(q.bi-last<=2)cur++;else cur=1;longest=Math.max(longest,cur);last=q.bi;if(near(q.y,c.h,8.5))gridLeak++}
  const longestRunFrac=longest/bins,gridLeakFrac=gridLeak/Math.max(1,series.length),medianY=median(series.map(q=>q.y)),sepStep=(lowCenter-medianY)/Math.max(1,Math.abs(stepY));
  // A photographed grid/moire alias can form a long, very thin same-colour path.
  // A real elevated trace cloud carries repeated multi-pixel support in a substantial
  // fraction of columns.  Use this only as a branch-identity gate; it changes no
  // selected Y value and introduces no calibration coefficient.
  const medianSupport=median(series.map(q=>q.n)),thickFrac=series.filter(q=>(q.clusterThickness||1)>=3).length/Math.max(1,series.length);
  const occupiedCols=columns.filter(q=>q.clusters.length>0),multiClusterFrac=occupiedCols.length?occupiedCols.filter(q=>q.clusters.length>=2).length/occupiedCols.length:0,meanClusters=occupiedCols.length?occupiedCols.reduce((z,q)=>z+q.clusters.length,0)/occupiedCols.length:0;
  const sy=series.map(q=>q.y).filter(Number.isFinite).sort((a,b)=>a-b),q10=sy.length?sy[Math.floor((sy.length-1)*.10)]:NaN,q90=sy.length?sy[Math.floor((sy.length-1)*.90)]:NaN;
  const ySpreadStep=(Number.isFinite(q10)&&Number.isFinite(q90))?(q90-q10)/Math.max(1,Math.abs(stepY)):0;
  const populationSupport=medianSupport>=7||thickFrac>=.55;
  // Sustained UI/text strokes can be the same colour and very thick, but often sit
  // above the actual numeric grid.  An elevated High rescue must remain physically
  // near the detected plot lattice; do not promote a branch more than ~half a grid
  // step above the top detected horizontal row.
  const gridRows=(c.h||[]).filter(Number.isFinite),topGrid=gridRows.length?Math.min(...gridRows):NaN;
  const topGridGuard=!Number.isFinite(topGrid)||medianY>=topGrid-Math.abs(stepY)*.35;
  const accepted=coverage>=.52&&xSpanFrac>=.62&&longestRunFrac>=.45&&gridLeakFrac<=.12&&sepStep>=.34&&populationSupport&&topGridGuard;
  return{accepted,series,coverage,xSpanFrac,longestRunFrac,gridLeakFrac,medianY,sepStep,medianSupport,thickFrac,ySpreadStep,multiClusterFrac,meanClusters,populationSupport,topGridGuard,topGrid};
}

function jointRangePopulations(c,scale,opt={}){
  let L=enumerateForeground(c,0,260).map(f=>scoreRangeCandidate(c,f,0,260,'low')).sort((a,b)=>b.score-a.score).slice(0,7);
  let H=enumerateForeground(c,270,500).map(f=>scoreRangeCandidate(c,f,270,500,'high')).sort((a,b)=>b.score-a.score).slice(0,7);
  const compactUnit=!!scale.diagnostics?.verifiedUnitStep;
  L=suppressTopBorderWhite(L,c.height);H=suppressTopBorderWhite(H,c.height);
  const wp=dominantWhitePair(L,H);
  if(wp){L=[wp.low];H=[wp.high]}else{L=suppressLikelyWhiteUi(L);H=suppressLikelyWhiteUi(H)}
  if(!L.length||!H.length)throw Error('Foreground population unresolved.');
  let best=null, second=null, pairItems=[];
  for(const l of L)for(const h of H){
    if(l.coverage<.10||h.coverage<.10)continue;
    const aff=pairAffinity(l,h);
    // Same plotted channel must explain both Low and High regions. This suppresses grid/text populations that occur in only one side.
    const balance=-Math.abs(l.coverage-h.coverage)*.8;
    const score=l.score+h.score+aff+balance;
    const item={l,h,score,aff};pairItems.push(item);
    if(!best||score>best.score){second=best;best=item;}else if(!second||score>second.score)second=item;
  }
  if(!best)throw Error('No joint Low/High foreground population.');
  const samePopulation=(a,b)=>a.mode===b.mode&&(a.mode==='white'||hd(a.hue,b.hue)<=20);
  pairItems.sort((a,b)=>b.score-a.score);
  const altLow=pairItems.find(q=>!samePopulation(q.l,best.l)&&samePopulation(q.h,best.h));
  const altHigh=pairItems.find(q=>samePopulation(q.l,best.l)&&!samePopulation(q.h,best.h));
  const altJoint=pairItems.find(q=>!samePopulation(q.l,best.l)||!samePopulation(q.h,best.h));
  const distinctMargins={
    low:altLow?best.score-altLow.score:99,
    high:altHigh?best.score-altHigh.score:99,
    joint:altJoint?best.score-altJoint.score:99
  };
  // Distinct margins are retained here and validated across the 3 trace samplings.
  // Same-trace boundary consistency: compare the tail of Low (near x=260) and head of High (near x=270).
  // We do not require identical Y because the true trace may step at the boundary; we only reject evidence
  // that strongly suggests a different foreground population was selected.
  const edgeMedian=(series,side)=>{
    if(!series.length)return NaN;
    const sorted=[...series].sort((a,b)=>a.xv-b.xv);
    const take=Math.max(2,Math.min(6,Math.ceil(sorted.length*.12)));
    const q=side==='tail'?sorted.slice(-take):sorted.slice(0,take);
    return median(q.map(v=>v.y));
  };
  const lowEdge=edgeMedian(best.l.series,'tail'),highEdge=edgeMedian(best.h.series,'head');
  const edgeGapPx=(Number.isFinite(lowEdge)&&Number.isFinite(highEdge))?Math.abs(lowEdge-highEdge):Infinity;
  const edgeGapFrac=edgeGapPx/Math.max(1,c.height);
  const modeConsistent=best.l.mode===best.h.mode;
  const hueGap=(best.l.mode==='color'&&best.h.mode==='color')?hd(best.l.hue,best.h.hue):0;
  // Different modes or a very large hue jump are stronger evidence of a population switch than a Y jump.
  if(!modeConsistent||hueGap>SAFETY.jointHueMax)throw Error('Low/High foreground identity mismatch.');
  // Boundary Y discontinuity is retained as diagnostic only. A true trace may step sharply at 260/270,
  // and hard rejection here reduced valid clean acceptance.
  let lowSeries=best.l.series;
  let highSeries=best.h.series,continuedPrefix=false,baselineContinuation=null,elevatedHighRescue=null;
  // If a decimal High region contains both a persistent Low baseline and a broad,
  // coherent elevated branch of the same plotted colour, preserve the real elevated
  // branch rather than allowing continuity DP to remain on the baseline.  Require a
  // sustained branch separated by >=0.34 physical grid step with broad X support and
  // low grid leakage. Prefix missing early High bins with the same-colour Low
  // continuation so the fixed 270-500 reporting interval remains represented.
  if(!compactUnit&&lowSeries.length&&samePopulation(best.l,best.h)&&Math.abs(scale.step||0)<0.1){
    const lowTail=lowSeries.slice(-Math.max(5,Math.ceil(lowSeries.length*.20))),lowCenter=median(lowTail.map(q=>q.y));
    const hRows=[...(c.h||[])].filter(Number.isFinite).sort((a,b)=>a-b),hDiff=hRows.slice(1).map((y,i)=>y-hRows[i]).filter(d=>d>3),stepY=hDiff.length?median(hDiff):Math.max(10,c.height*.16);
    const elevated=elevatedHighBranch(c,best.h,270,500,lowCenter,stepY);
    if(elevated.accepted){
      const first=Math.min(...elevated.series.map(q=>q.bi)),prefix=candidateSeries(c,best.l,270,500).series.filter(q=>q.bi<first),byBin=new Map();
      for(const q of prefix)byBin.set(q.bi,q);for(const q of elevated.series)byBin.set(q.bi,q);
      const merged=[...byBin.values()].sort((a,b)=>a.bi-b.bi),mergedSpan=merged.length>1?(merged.at(-1).bi-merged[0].bi+1)/61:0;
      if(merged.length>=20&&mergedSpan>=.78){highSeries=merged;elevatedHighRescue={accepted:true,...elevated,prefixBins:prefix.length,mergedSpan};}
    }
  }
  // r17: if the same colour population forms a persistent low-level path through the
  // entire High X range, keep that geometric continuation instead of hopping to sparse
  // high outliers. Genuine Gain plots do not trigger this because their Low baseline
  // terminates near the Low/High boundary and therefore lacks the required High coverage.
  if(lowSeries.length&&samePopulation(best.l,best.h)&&Math.abs(scale.step||0)<0.1){
    const lowTail=lowSeries.slice(-Math.max(5,Math.ceil(lowSeries.length*.20))), lowCenter=median(lowTail.map(q=>q.y));
    const hRows=[...(c.h||[])].filter(Number.isFinite).sort((a,b)=>a-b), hDiff=hRows.slice(1).map((y,i)=>y-hRows[i]).filter(d=>d>3);
    const stepY=hDiff.length?median(hDiff):Math.max(10,c.height*.16);
    baselineContinuation=persistentBaselineContinuation(c,best.l,270,500,lowCenter,stepY);
    // Same-hue monitor moire can form a coherent elevated ghost whose geometry
    // resembles a real High cloud. Verify that the proposed elevated branch has
    // comparable photographed saturation/luminance to the independently recovered
    // baseline continuation before allowing it to replace High. This is a foreground
    // identity check only; no Y value or calibration coefficient is involved.
    if(elevatedHighRescue?.series?.length&&baselineContinuation?.series?.length&&best.h.mode==='color'){
      const colorSummary=(ser)=>{const z=ser.map(q=>{const x=Math.max(0,Math.min(c.width-1,Math.round(q.xv/500*(c.width-1)))),y=Math.max(0,Math.min(c.height-1,Math.round(q.y))),i=(y*c.width+x)*4;return stat(c.data[i],c.data[i+1],c.data[i+2])});return{sat:median(z.map(v=>v.sat)),lum:median(z.map(v=>v.lum))}};
      const ec=colorSummary(elevatedHighRescue.series),bc=colorSummary(baselineContinuation.series);
      const samePhotometricTrace=Number.isFinite(ec.sat)&&Number.isFinite(ec.lum)&&Number.isFinite(bc.sat)&&Number.isFinite(bc.lum)&&ec.sat>=bc.sat*.55&&ec.lum>=bc.lum*.55;
      elevatedHighRescue.photometricIdentity={accepted:samePhotometricTrace,elevated:ec,baseline:bc};
      if(!samePhotometricTrace){elevatedHighRescue=null;highSeries=best.h.series;}
    }
    const currentMed=median(highSeries.map(q=>q.y));
    if(!elevatedHighRescue&&baselineContinuation.accepted&&Number.isFinite(currentMed)&&Math.abs(currentMed-lowCenter)>stepY*.32){
      highSeries=baselineContinuation.series;
    }
  }
  if(compactUnit&&samePopulation(best.l,best.h)&&best.h.xSpanFrac<.86&&best.h.series.length){
    const highStart=Math.min(...best.h.series.map(q=>q.xv));
    const continuation=candidateSeries(c,best.l,270,500).series.filter(q=>q.xv<highStart-1e-6);
    if(continuation.length>=4){
      const byBin=new Map();for(const q of continuation)byBin.set(q.bi,q);for(const q of best.h.series)byBin.set(q.bi,q);
      highSeries=[...byBin.values()].sort((a,b)=>a.bi-b.bi);continuedPrefix=true;
    }
  }
  // r25-dev57 reconstruction of dev46's decimal boundary-baseline rescue.
  // A photographed green/moire path may occupy most of Low, then meet the real baseline only
  // at the fixed 260/270 boundary. When Low/High physically meet there but their raw robust
  // means disagree by >=0.45 axis step, reconstruct each fixed range around the observed
  // boundary level. This changes trace-pixel selection only; no calibration/value offset is used.
  let boundaryBaselineRescue=null;
  if(!elevatedHighRescue&&!compactUnit&&samePopulation(best.l,best.h)&&Math.abs(scale.step||0)<0.1&&Number.isFinite(lowEdge)&&Number.isFinite(highEdge)){
    const hRows=[...(c.h||[])].filter(Number.isFinite).sort((a,b)=>a-b),hDiff=hRows.slice(1).map((y,i)=>y-hRows[i]).filter(d=>d>3);
    const stepY=hDiff.length?median(hDiff):Math.max(10,c.height*.16);
    // Normally the selected Low/High paths must physically meet at 260/270.  At
    // some sampling resolutions a moire alias can steal the selected High path
    // entirely, producing a gross boundary jump even though the same-colour Low
    // baseline independently continues through the High range.  Treat that
    // independently verified continuation as boundary evidence only when the
    // selected jump is >0.55 physical grid step and the continuation stays within
    // 0.30 step of the Low tail.  The subsequent two-sided reconstruction must still
    // span >=90% of both fixed ranges and agree within 0.30 value step.
    const continuationBoundary=!!baselineContinuation?.accepted&&baselineContinuation.driftStep<=.30&&Math.abs(lowEdge-highEdge)>=stepY*.55;
    const edgeCenter=continuationBoundary?lowEdge:(lowEdge+highEdge)/2;
    const edgeNear=Math.abs(lowEdge-highEdge)<=Math.max(3,stepY*.08)||continuationBoundary;
    const rawLv=valuesFromSeries(lowSeries,c,scale),rawHv=valuesFromSeries(highSeries,c,scale);
    const rawLow=robustAccepted(rawLv,scale.step,lowSeries).mean,rawHigh=robustAccepted(rawHv,scale.step,highSeries).mean;
    if(edgeNear&&Number.isFinite(rawLow)&&Number.isFinite(rawHigh)&&Math.abs(rawLow-rawHigh)>=Math.abs(scale.step)*.45){
      const rl=persistentBaselineContinuation(c,best.l,0,260,edgeCenter,stepY),rh=persistentBaselineContinuation(c,best.h,270,500,edgeCenter,stepY);
      if(rl.series.length>=10&&rh.series.length>=10&&rl.xSpanFrac>=.90&&rh.xSpanFrac>=.90){
        const rlv=valuesFromSeries(rl.series,c,scale),rhv=valuesFromSeries(rh.series,c,scale),rla=robustAccepted(rlv,scale.step,rl.series),rha=robustAccepted(rhv,scale.step,rh.series);
        if(Number.isFinite(rla.mean)&&Number.isFinite(rha.mean)&&Math.abs(rla.mean-rha.mean)<=Math.abs(scale.step)*.30){
          lowSeries=rl.series;highSeries=rh.series;
          boundaryBaselineRescue={accepted:true,edgeCenterY:edgeCenter,stepY,rawLow,rawHigh,rescuedLow:rla.mean,rescuedHigh:rha.mean,lowCoverage:rl.coverage,highCoverage:rh.coverage,lowXSpan:rl.xSpanFrac,highXSpan:rh.xSpanFrac};
        }
      }
    }
  }
  const lv=valuesFromSeries(lowSeries,c,scale),hv=valuesFromSeries(highSeries,c,scale);
  if(lv.length<10||hv.length<10)throw Error('Not enough joint population trace bins.');
  // Low UI/text contamination tends to form short horizontal clusters. Do not accept a
  // selected Low population that is both short-lived and visibly grid-contaminated.
  // This is a rejection gate only; it never changes the reported mean.
  if(best.l.longestRunFrac<SAFETY.lowPersistenceMin&&best.l.gridLeakFrac>SAFETY.lowGridLeakMaxForWeak)throw Error('Low foreground persistence unresolved.');
  if(best.h.xSpanFrac<SAFETY.highXSpanMin&&best.h.clusterRate>SAFETY.highClusterRateMaxForNarrow)throw Error('High foreground span unresolved.');
  const sustain=compactUnit,labels=(scale.values||[]).filter(Number.isFinite),compactHardMax=compactUnit&&labels.length?Math.max(...labels)+Math.abs(scale.step)*.25:Infinity;
  const la=robustAccepted(lv,scale.step,lowSeries,{sustainedRuns:false,hardMax:compactHardMax}),ha=robustAccepted(hv,scale.step,highSeries,{sustainedRuns:sustain,rescueReference:la.mean,hardMax:compactHardMax});
  const samplePack=(series,accepted,values)=>accepted.map((srcIndex,k)=>({x:series[srcIndex].xv,yCanonical:series[srcIndex].y,value:values[k],sourceIndex:srcIndex}));
  const acceptedEvidence=(series,indices,a,b)=>{
    const retention=series.length?indices.length/series.length:0;
    const xs=indices.map(i=>series[i].xv).sort((x,y)=>x-y);
    const xSpan=xs.length>1?(xs[xs.length-1]-xs[0])/Math.max(1,b-a):0;
    let longest=0,cur=0,last=-99,maxGap=0;
    for(const i of indices){const bi=series[i]?.bi??-99;if(bi-last<=2)cur++;else cur=1;longest=Math.max(longest,cur);last=bi}
    for(let i=1;i<xs.length;i++)maxGap=Math.max(maxGap,xs[i]-xs[i-1]);
    const quartileCounts=[0,0,0,0];
    for(const x of xs){const k=Math.min(3,Math.max(0,Math.floor((x-a)/Math.max(1,b-a)*4)));quartileCounts[k]++}
    return {retention,xSpan,longestAcceptedRunFrac:longest/61,quartileCounts,occupiedQuartiles:quartileCounts.filter(n=>n>0).length,minQuartileCount:Math.min(...quartileCounts),maxGapFrac:maxGap/Math.max(1,b-a)};
  };
  const lowEvidence=acceptedEvidence(lowSeries,la.indices,0,260),highEvidence=acceptedEvidence(highSeries,ha.indices,270,500);
  const lowSamples=samplePack(lowSeries,la.indices,la.values),highSamples=samplePack(highSeries,ha.indices,ha.values);
  const lowYStats=acceptedYStats(lowSamples,scale.step,0,260),highYStats=acceptedYStats(highSamples,scale.step,270,500);
  if(!opt.diagnosticSkipY&&(acceptedYUnsafe(lowYStats)||acceptedYUnsafe(highYStats)))throw Error('Accepted trace Y distribution is unstable.');
  if(scale.diagnostics?.fiveDecimalRescue){
    const labels=(scale.values||[]).filter(Number.isFinite),st=Math.max(1e-12,Math.abs(scale.step||0));
    const nearLabel=v=>labels.length&&Math.min(...labels.map(q=>Math.abs(v-q)/st))<=.20;
    const gridCaptured=(fg,ys)=>fg&&fg.gridLeakFrac>.55&&nearLabel(ys.median);
    if(gridCaptured(best.l,lowYStats)||gridCaptured(best.h,highYStats))
      throw Error('Trace population overlaps a Y-grid line too strongly.');
  }
  const lowEnvelope=affineTraceEnvelope(scale,lowSamples),highEnvelope=affineTraceEnvelope(scale,highSamples);
  if(!opt.diagnosticSkipEnvelope&&(!lowEnvelope.accepted||!highEnvelope.accepted))throw Error('Trace values require excessive extrapolation beyond visible Y-axis labels.');
  // Accepted samples must support the whole requested X interval. Reject only severe one-sided/localized support.
  const edgeContaminationSafe=(ev,fg)=>compactUnit&&ev&&fg&&ev.occupiedQuartiles===3&&(ev.quartileCounts[0]===0||ev.quartileCounts[3]===0)&&ev.retention>=.65&&ev.xSpan>=.68&&ev.maxGapFrac<=.12&&fg.coverage>=.85&&fg.xSpanFrac>=.95;
  // r25-dev59: a fixed High range may contain a short early baseline followed by a
  // sustained elevated cloud. robustAccepted can legitimately discard that first
  // quartile as a different level even though the selected foreground itself spans
  // essentially the entire 270-500 range. Treat that as distribution-safe only when
  // the underlying same-color foreground is dense, continuous and low-grid-leak.
  // This changes no samples or values; it only prevents the X-distribution validator
  // from mistaking a late-start physical population for localized support.
  const lateStartHighSafe=(ev,fg)=>!!ev&&!!fg&&ev.occupiedQuartiles===3&&ev.quartileCounts[0]===0&&ev.retention>=.70&&ev.xSpan>=.68&&ev.maxGapFrac<=.06&&fg.coverage>=.88&&fg.xSpanFrac>=.98&&fg.gridLeakFrac<=.12&&fg.clusterRate<=.08;
  // Boundary-baseline rescue already requires the reconstructed path itself to span
  // >=90% of both immutable reporting ranges and the two rescued means to agree within
  // 0.30 axis step. robustAccepted may subsequently trim one edge population at a
  // sampling resolution, so do not re-reject that proven full-span rescue merely
  // because retained inliers occupy three rather than four quartiles.
  const boundaryRescueDistributionSafe=(ev,side)=>{
    if(!boundaryBaselineRescue?.accepted||!ev)return false;
    const rescueSpan=side==='low'?boundaryBaselineRescue.lowXSpan:boundaryBaselineRescue.highXSpan;
    return rescueSpan>=.90&&ev.occupiedQuartiles>=3&&ev.retention>=.65&&ev.xSpan>=.62&&ev.maxGapFrac<=.08;
  };
  const lowDistBad=acceptedDistributionUnsafe(lowEvidence)&&!edgeContaminationSafe(lowEvidence,best.l)&&!boundaryRescueDistributionSafe(lowEvidence,'low'),highDistBad=acceptedDistributionUnsafe(highEvidence)&&!edgeContaminationSafe(highEvidence,best.h)&&!lateStartHighSafe(highEvidence,best.h)&&!boundaryRescueDistributionSafe(highEvidence,'high');
  if(!opt.diagnosticSkipDistribution&&(lowDistBad||highDistBad))throw Error('Accepted trace samples are too localized across X.');
  const pack=q=>({mode:q.mode,hue:q.hue,score:q.score,coverage:q.coverage,denseCoverage:q.denseCoverage,gridLeakFrac:q.gridLeakFrac,continuity:q.continuity,longestRunFrac:q.longestRunFrac,isolatedFrac:q.isolatedFrac,xSpanFrac:q.xSpanFrac,clusterRate:q.clusterRate,medianY:q.series?.length?median(q.series.map(s=>s.y)):NaN});
  return{
    low:{mean:la.mean,count:la.values.length,rawCount:lv.length,foreground:pack(best.l),acceptedEvidence:lowEvidence,acceptedYStats:lowYStats,affineEnvelope:lowEnvelope,acceptedSamples:lowSamples},
    high:{mean:ha.mean,count:ha.values.length,rawCount:hv.length,foreground:pack(best.h),acceptedEvidence:highEvidence,acceptedYStats:highYStats,affineEnvelope:highEnvelope,acceptedSamples:highSamples},
    affinity:best.aff, jointScore:best.score, margin:second?best.score-second.score:99,distinctMargins,
    boundary:{lowEdgeY:lowEdge,highEdgeY:highEdge,edgeGapPx,edgeGapFrac,modeConsistent,hueGap},baselineContinuation,boundaryBaselineRescue,elevatedHighRescue,
    lowCandidates:L.map(pack),highCandidates:H.map(pack)
  };
}
function displayLineFromAccepted(samples){return samples.map(s=>({x:s.x,value:s.value,yCanonical:s.yCanonical,sourceIndex:s.sourceIndex}))}
function extractTraceAtSize(img,plot,scale,W=500,H=240,opt={}){
  const p=normalizePlot(plot),c=canonical(img,p,W,H),sc={...scale,_top:p.top,_bottom:p.bottom};
  // Energy is non-negative. Use the already validated affine scale only as a search gate;
  // this does not assume the plot bottom equals zero and does not participate in axis fitting.
  // dev46 grid/moire path hardening is a decimal-family repair. Keep compact 3/2/1
  // foreground selection unchanged so existing Gain-family populations cannot move.
  c.gridPathPenaltyEnabled=!scale.diagnostics?.verifiedUnitStep&&Math.abs(scale.step||0)<0.1;
  if(Number.isFinite(scale.slope)&&scale.slope<0&&Number.isFinite(scale.intercept)){
    const zeroY=-scale.intercept/scale.slope;
    const stepPx=Math.abs((scale.step||0)/scale.slope);
    const maxOrigY=zeroY+stepPx*.10;
    c.energyMaxY=Math.max(4,Math.min(c.height-5,(maxOrigY-p.top)/(p.bottom-p.top)*(c.height-1)));
  }
  const j=jointRangePopulations(c,sc,opt);
  j.low.displayLine=displayLineFromAccepted(j.low.acceptedSamples);j.high.displayLine=displayLineFromAccepted(j.high.acceptedSamples);return{foreground:{low:j.low.foreground,high:j.high.foreground,affinity:j.affinity,jointScore:j.jointScore,margin:j.margin,distinctMargins:j.distinctMargins,boundary:j.boundary},low:j.low,high:j.high,canonical:{w:c.width,h:c.height},candidates:{low:j.lowCandidates,high:j.highCandidates},elevatedHighRescue:j.elevatedHighRescue,baselineContinuation:j.baselineContinuation,boundaryBaselineRescue:j.boundaryBaselineRescue};
}

function extractTrace(img,plot,scale,opt={}){return extractTraceAtSize(img,plot,scale,500,240,opt)}
function distinctMarginConsensus(runs){
  const mid=Math.floor(runs.length/2);
  const summarize=(k)=>{
    const a=runs.map(r=>r.foreground?.distinctMargins?.[k]??-Infinity);
    const med=median(a),mn=Math.min(...a),center=a[mid];
    return {values:a,center,median:med,min:mn,accepted:center>=SAFETY.distinctCenterMin&&med>=SAFETY.distinctMedianMin&&mn>=SAFETY.distinctValidationMin};
  };
  const low=summarize('low'),high=summarize('high'),joint=summarize('joint');
  return {accepted:low.accepted&&high.accepted&&joint.accepted,low,high,joint};
}
function traceConfidenceDiagnostic(mid,lowStepSpan,highStepSpan,lowIdentity,highIdentity,marginConsensus,limit){
  const clamp=x=>Math.max(0,Math.min(1,x));
  const sampling=clamp(1-Math.max(lowStepSpan,highStepSpan)/Math.max(.001,limit));
  const lowRaw=clamp((mid.low.foreground.longestRunFrac-.18)/.55);
  const lowAccepted=clamp((mid.low.acceptedEvidence?.longestAcceptedRunFrac||0)/.55);
  const lowRetention=clamp((mid.low.acceptedEvidence?.retention||0)/.80);
  const lowPersistence=clamp(lowRaw*.45+lowAccepted*.30+lowRetention*.25);
  const highSpan=clamp((mid.high.foreground.xSpanFrac-.40)/.55);
  const identityHue=Math.max(lowIdentity.hueSpan,highIdentity.hueSpan,mid.foreground?.boundary?.hueGap||0);
  const identity=clamp(1-identityHue/42);
  const dm=[marginConsensus.low.center,marginConsensus.high.center,marginConsensus.joint.center].filter(Number.isFinite);
  const margin=clamp(Math.min(...dm)/1.5);
  const grid=clamp(1-Math.max(mid.low.foreground.gridLeakFrac||0,mid.high.foreground.gridLeakFrac||0));
  const parts={sampling,lowPersistence,highSpan,identity,margin,grid};
  const weights={sampling:.25,lowPersistence:.15,highSpan:.15,identity:.15,margin:.20,grid:.10};
  const score=Math.round(100*Object.keys(parts).reduce((s,k)=>s+parts[k]*weights[k],0));
  const level=score>=85?'strong':score>=70?'good':'borderline';
  return {score,level,diagnosticOnly:true,parts:Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,Math.round(v*100)]))};
}
function extractTraceConsensus(img,plot,scale,opt={}){
  const sizes=opt.sizes||[[400,192],[500,240],[600,288]], compactUnit=!!scale.diagnostics?.verifiedUnitStep, limit=Number.isFinite(opt.maxStepSpan)?opt.maxStepSpan:(compactUnit?.85:SAFETY.samplingMaxStepSpan);
  const runs=sizes.map(([w,h])=>extractTraceAtSize(img,plot,scale,w,h,opt));
  const span=q=>{const a=runs.map(r=>r[q].mean);return Math.max(...a)-Math.min(...a)};
  const lowSpan=span('low'),highSpan=span('high'),step=Math.max(1e-12,Math.abs(scale.step||0));
  const lowStepSpan=lowSpan/step,highStepSpan=highSpan/step;
  const marginConsensus=distinctMarginConsensus(runs);
  const identity=(side)=>{
    const f=runs.map(r=>r.foreground[side]), modes=[...new Set(f.map(q=>q.mode))];
    let hueSpan=0;
    if(modes.length===1&&modes[0]==='color'){
      const hs=f.map(q=>q.hue);
      for(let i=0;i<hs.length;i++)for(let j=i+1;j<hs.length;j++)hueSpan=Math.max(hueSpan,hd(hs[i],hs[j]));
    }
    return {modeStable:modes.length===1,hueSpan};
  };
  const lowIdentity=identity('low'),highIdentity=identity('high');
  // Sampling stability must preserve not only the reported value but also the selected foreground population.
  // A mode flip or a large hue jump means a different UI/trace population won at another sampling density.
  const identityOk=lowIdentity.modeStable&&highIdentity.modeStable&&lowIdentity.hueSpan<=SAFETY.samplingHueDriftMax&&highIdentity.hueSpan<=SAFETY.samplingHueDriftMax;
  const runStrong=(r)=>!!r&&
    (r.low?.foreground?.coverage||0)>=.80&&(r.high?.foreground?.coverage||0)>=.65&&
    (r.low?.foreground?.gridLeakFrac??1)<=.11&&(r.high?.foreground?.gridLeakFrac??1)<=.11&&
    (r.low?.foreground?.xSpanFrac||0)>=.90&&(r.high?.foreground?.xSpanFrac||0)>=.70&&
    (r.low?.acceptedEvidence?.retention||0)>=.62&&(r.high?.acceptedEvidence?.retention||0)>=.62&&
    (r.low?.acceptedEvidence?.occupiedQuartiles||0)>=3&&(r.high?.acceptedEvidence?.occupiedQuartiles||0)>=3;
  // Margin is only a tie-breaker. When every sampling density independently tracks the
  // same high-coverage, low-grid-leak foreground and reports nearly identical values,
  // an ambiguous alternative margin is not evidence that the measured trace changed.
  const trackedPopulationOk=identityOk&&lowStepSpan<=.20&&highStepSpan<=.20&&runs.every(runStrong);
  const sameRunIdentity=(a,b)=>{
    if(!a||!b)return false;
    for(const side of ['low','high']){
      const x=a.foreground?.[side],y=b.foreground?.[side];if(!x||!y||x.mode!==y.mode)return false;
      if(x.mode==='color'&&hd(x.hue,y.hue)>Math.min(SAFETY.samplingHueDriftMax,18))return false;
    }
    return true;
  };
  const robustPairs=[];
  if(compactUnit){
    for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
      const a=runs[i],b=runs[j],ld=Math.abs(a.low.mean-b.low.mean)/step,hdiff=Math.abs(a.high.mean-b.high.mean)/step;
      if(ld<=.24&&hdiff<=.24&&sameRunIdentity(a,b)&&runStrong(a)&&runStrong(b)){
        const evidence=(a.low.acceptedEvidence.retention+a.high.acceptedEvidence.retention+b.low.acceptedEvidence.retention+b.high.acceptedEvidence.retention)/4;
        const grid=(a.low.foreground.gridLeakFrac+a.high.foreground.gridLeakFrac+b.low.foreground.gridLeakFrac+b.high.foreground.gridLeakFrac)/4;
        robustPairs.push({i,j,lowStepDiff:ld,highStepDiff:hdiff,score:evidence-grid});
      }
    }
    robustPairs.sort((a,b)=>b.score-a.score);
  }
  let robustPair=robustPairs[0]||null;
  // r11 compact-baseline rescue.  On 3/2/1 plots the validated affine model places the
  // next grid level at zero.  If exactly one sampling density jumps to another Low
  // population while two samplings independently stay near that affine zero baseline,
  // keep the agreeing pair.  This does not assume the image bottom is zero: the baseline
  // comes from the already accepted 3/2/1 affine calibration.
  if(!robustPair&&compactUnit&&identityOk&&highStepSpan<=.20){
    const baselinePairs=[];
    for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
      const a=runs[i],b=runs[j];
      const ld=Math.abs(a.low.mean-b.low.mean)/step,hdiff=Math.abs(a.high.mean-b.high.mean)/step;
      const nearZero=Math.max(Math.abs(a.low.mean),Math.abs(b.low.mean))/step<=.45;
      const moderate=(r)=>
        (r.low?.acceptedEvidence?.retention||0)>=.45&&(r.high?.acceptedEvidence?.retention||0)>=.55&&
        (r.low?.acceptedEvidence?.occupiedQuartiles||0)>=3&&(r.high?.acceptedEvidence?.occupiedQuartiles||0)>=3&&
        (r.low?.foreground?.xSpanFrac||0)>=.82&&(r.high?.foreground?.xSpanFrac||0)>=.68&&
        (r.low?.foreground?.gridLeakFrac??1)<=.22&&(r.high?.foreground?.gridLeakFrac??1)<=.16;
      if(ld<=.24&&hdiff<=.24&&nearZero&&sameRunIdentity(a,b)&&moderate(a)&&moderate(b)){
        const evidence=(a.low.acceptedEvidence.retention+a.high.acceptedEvidence.retention+b.low.acceptedEvidence.retention+b.high.acceptedEvidence.retention)/4;
        baselinePairs.push({i,j,lowStepDiff:ld,highStepDiff:hdiff,score:evidence,baselineRescue:true});
      }
    }
    baselinePairs.sort((a,b)=>b.score-a.score);
    robustPair=baselinePairs[0]||null;
  }
  const globalOk=lowStepSpan<=limit&&highStepSpan<=limit&&identityOk&&(marginConsensus.accepted||trackedPopulationOk);
  // Two-run rescue is deliberately narrower than a majority vote: both runs must have
  // strong X support, low grid leakage, the same foreground identity, and values within
  // 0.24 axis steps. It only removes one sampling-density outlier.
  if(!globalOk&&!robustPair)throw Error(`Trace sampling consensus rejected (Low ${lowStepSpan.toFixed(3)} step, High ${highStepSpan.toFixed(3)} step, identity ${identityOk?'stable':'changed'}, margin ${marginConsensus.accepted?'stable':trackedPopulationOk?'tracked-population':'ambiguous'}).`);
  let mid=runs[Math.floor(runs.length/2)],usedRuns=[0,1,2],consensusMode=trackedPopulationOk&&!marginConsensus.accepted?'tracked-population':'all-runs';
  if(!globalOk&&robustPair){
    usedRuns=[robustPair.i,robustPair.j];consensusMode=robustPair.baselineRescue?'compact-affine-baseline-pair':'robust-pair';
    const preferred=usedRuns.includes(Math.floor(runs.length/2))?Math.floor(runs.length/2):
      usedRuns.sort((i,j)=>((runs[j].low.acceptedEvidence.retention+runs[j].high.acceptedEvidence.retention)-(runs[i].low.acceptedEvidence.retention+runs[i].high.acceptedEvidence.retention)))[0];
    mid=runs[preferred];
  }
  const usedLowSpan=Math.max(...usedRuns.map(i=>runs[i].low.mean))-Math.min(...usedRuns.map(i=>runs[i].low.mean));
  const usedHighSpan=Math.max(...usedRuns.map(i=>runs[i].high.mean))-Math.min(...usedRuns.map(i=>runs[i].high.mean));
  const usedLowStepSpan=usedLowSpan/step,usedHighStepSpan=usedHighSpan/step;
  mid.traceStability={accepted:true,mode:consensusMode,maxStepSpan:limit,lowStepSpan:usedLowStepSpan,highStepSpan:usedHighStepSpan,
    allRunLowStepSpan:lowStepSpan,allRunHighStepSpan:highStepSpan,lowIdentity,highIdentity,marginConsensus,trackedPopulationOk,robustPair,usedRuns,
    runs:runs.map((r,i)=>({size:sizes[i],low:r.low.mean,high:r.high.mean,lowMode:r.foreground.low.mode,lowHue:r.foreground.low.hue,highMode:r.foreground.high.mode,highHue:r.foreground.high.hue,jointMargin:r.foreground.margin,distinctMargins:r.foreground.distinctMargins,strong:runStrong(r)}))};
  mid.traceConfidence=traceConfidenceDiagnostic(mid,usedLowStepSpan,usedHighStepSpan,lowIdentity,highIdentity,marginConsensus,limit);
  return mid;
}
module.exports={...geom,SAFETY,clusterRows,continuityPath,persistentBaselineContinuation,elevatedHighBranch,findPlot,normalizePlot,canonical,enumerateForeground,scoreRangeCandidate,findPlot,extractTrace,extractTraceAtSize,extractTraceConsensus,distinctMarginConsensus,traceConfidenceDiagnostic,acceptedDistributionUnsafe,acceptedYStats,acceptedYUnsafe,affineTraceEnvelope,chooseRangeForeground,jointRangePopulations,robustAccepted,displayLineFromAccepted};

}
};
var cache={};
function req(id){if(id.startsWith('./'))id=id.slice(2);if(!id.endsWith('.js'))id+='.js';if(cache[id])return cache[id].exports;if(!modules[id])throw Error('Module not bundled: '+id);var m={exports:{}};cache[id]=m;modules[id](m,m.exports,req);return m.exports;}
global.EGSV2Core=req('core_v2_canonical_pipeline37_family_arbitrated.js');
})(typeof window!=="undefined"?window:globalThis);
