import {runAnalysisValidation,type ValidationWorkerRequest,type ValidationWorkerResponse} from './validation';
const port=self as unknown as {postMessage:(message:ValidationWorkerResponse)=>void;onmessage:((event:MessageEvent<ValidationWorkerRequest>)=>void)|null};
let active:{id:string;abort:AbortController}|undefined;
port.onmessage=({data})=>{
  if(data.type==='cancel'){if(active?.id===data.jobId)active.abort.abort();return;}
  active?.abort.abort();const job={id:data.jobId,abort:new AbortController()};active=job;
  void runAnalysisValidation(data.request,{signal:job.abort.signal,onProgress:progress=>{if(active===job)port.postMessage({type:'progress',jobId:job.id,progress});}})
    .then(report=>{if(active===job)port.postMessage({type:'result',jobId:job.id,report});})
    .catch(error=>{if(active===job)port.postMessage(error instanceof Error&&error.name==='AbortError'?{type:'cancelled',jobId:job.id}:{type:'error',jobId:job.id,message:error instanceof Error?error.message:String(error)});})
    .finally(()=>{if(active===job)active=undefined;});
};
