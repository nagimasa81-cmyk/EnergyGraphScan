'use strict';
importScripts('./egs-v2-core.bundle.js?v=2.0.7-r25-RC2-dev2');
function toTransportResult(result){
  if(!result||typeof result!=='object')return result;
  if(result.axis&&typeof result.axis==='object'&&typeof result.axis.mapY==='function'){const axis={...result.axis};delete axis.mapY;return {...result,axis};}
  return result;
}
self.onmessage=function(e){
  const m=e.data||{};
  if(m.type!=='analyze')return;
  try{
    const img={width:m.width,height:m.height,data:new Uint8ClampedArray(m.buffer)};
    const result=self.EGSV2Core.analyze(img);
    result.runtimeCore=self.EGSV2Core.RUNTIME_CORE||'unknown-core';
    // Drop the transferred full-resolution input reference before posting the result.
    // The core result contains only analysis outputs, not the source RGBA image.
    img.data=null; m.buffer=null;
    self.postMessage({id:m.id,ok:true,result:toTransportResult(result)});
  }catch(err){
    self.postMessage({id:m.id,ok:false,error:String(err&&err.message||err),stack:String(err&&err.stack||'')});
  }
};
