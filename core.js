(() => {
  const SAMPLE_SPLIT = 270;
  const SAMPLE_AXIS_MAX = 500;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;if(!n)return NaN;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2};
  function robust(values,z=3.5,floor=.0003){const a=values.filter(Number.isFinite);if(!a.length)return[];const med=median(a),mad=median(a.map(v=>Math.abs(v-med)));if(mad<1e-9)return a.filter(v=>Math.abs(v-med)<=Math.max(floor,Math.abs(med)*.15));return a.filter(v=>Math.abs(v-med)/(1.4826*mad)<=z)}
  function horizontalLevels(xs,vals,top,width){const split=(width-1)*SAMPLE_SPLIT/SAMPLE_AXIS_MAX,margin=Math.max(2,width*.018);let l=[],r=[];for(let i=0;i<xs.length;i++){if(xs[i]<=split-margin)l.push(vals[i]);if(xs[i]>=split+margin)r.push(vals[i])}if(l.length<4||r.length<4)throw Error('Low/High regions do not contain enough signal samples');l=robust(l,3.5,Math.max(.0002,top*.01));r=robust(r,3.5,Math.max(.0002,top*.01));if(!l.length||!r.length)throw Error('Signal samples were removed as outliers');const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;const low=mean(l),high=mean(r),delta=Math.abs(median(r)-median(l));return{low,high,confidence:clamp(delta/Math.max(.00001,top*.20),0,1)}}
  function geometry(box){return{x0:box.x+box.w*.145,y0:box.y+box.h*.08,x1:box.x+box.w-4,y1:box.y+box.h*.73}}
  function splitX(box){const g=geometry(box);return g.x0+(g.x1-g.x0)*SAMPLE_SPLIT/SAMPLE_AXIS_MAX}
  function valueY(box,v,top){const g=geometry(box);return g.y1-clamp(v/Math.max(top,1e-12),0,1)*(g.y1-g.y0)}
  function spec(mode,low,high){if(mode==='Noise')return low>=0&&low<=.015&&high>=.001&&high<=.02;if(mode==='Gain')return high>=1&&high<=1.5;return false}
  window.EGSCore={SAMPLE_SPLIT,SAMPLE_AXIS_MAX,clamp,median,robust,horizontalLevels,geometry,splitX,valueY,spec};
})();
