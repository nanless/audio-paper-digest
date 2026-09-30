'use strict';
const pending=()=>Object.assign(new Error('Source classification dispatch stopped; response checkpoints retained'),{code:'SOURCE_CLASSIFICATION_PENDING'});
async function runBounded(items,{concurrency=1,processItem,isRunFailure,onProgress,signal}={}) {
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3||typeof processItem!=='function'||typeof isRunFailure!=='function')throw new Error('Source classifier concurrency must be 1–3');
 let cursor=0,stopped=null;const results=new Array(items.length);
 const stop=reason=>{if(!stopped)stopped=reason;};
 const abort=()=>stop({status:'operator-stopped',error:'Stop requested; unfinished papers remain pending'});
 if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
 const worker=async()=>{
  while(!stopped&&cursor<items.length) {
   const index=cursor++,item=items[index];
   const control={get stopped(){return stopped;},stop,
    request:async call=>{
     if(stopped)throw pending();
     try{return await call();}catch(error){const status=isRunFailure(error);if(status)stop({paperId:item.paperId,status,error:String(error.message)});throw error;}
    }};
   try {
    const result=await processItem(item,index,control);
    if(result) {results[index]=result;await onProgress?.(results.slice(),{stopped});}
   }catch(error){
    const status=isRunFailure(error);
    if(status)stop({paperId:item.paperId,status,error:String(error.message)});
    else if(error.code!=='SOURCE_CLASSIFICATION_PENDING') {stop({paperId:item.paperId,status:'local-integrity-failure',error:String(error.message)});}
   }
  }
 };
 try{await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));}finally{signal?.removeEventListener('abort',abort);}
 return {results,stopped};
}
module.exports={runBounded,pending};
