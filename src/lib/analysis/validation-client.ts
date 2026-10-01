import type {ValidationRequest,ValidationReport,ValidationProgress,ValidationWorkerRequest,ValidationWorkerResponse} from './validation';
/** Dedicated worker is terminated on cancellation, including a synchronous
 * detector. Keep this factory outside validation.ts to avoid a recursive
 * worker bundle; worker execution imports only the pure runner. */
export function createAnalysisValidationJob(request:ValidationRequest,onProgress?:(progress:ValidationProgress)=>void):{promise:Promise<ValidationReport>;cancel:()=>void}{
  const worker=new Worker(new URL('./validation.worker.ts',import.meta.url),{type:'module'}),jobId=crypto.randomUUID();
  const cancelled=()=>new DOMException('分析验收已取消','AbortError');
  let rejectJob:(error:unknown)=>void=()=>{},settled=false;
  const promise=new Promise<ValidationReport>((resolve,reject)=>{rejectJob=reject;
    worker.onmessage=({data}:MessageEvent<ValidationWorkerResponse>)=>{if(data.jobId!==jobId||settled)return;
      if(data.type==='progress'){onProgress?.(data.progress);return;}settled=true;worker.terminate();
      if(data.type==='result')resolve(data.report);else reject(data.type==='cancelled'?cancelled():new Error(data.message));};
    worker.onerror=event=>{if(!settled){settled=true;worker.terminate();reject(new Error(event.message||'研究 Worker 运行失败'));}};
    worker.postMessage({type:'run',jobId,request} satisfies ValidationWorkerRequest);
  });
  return {promise,cancel(){if(settled)return;settled=true;worker.postMessage({type:'cancel',jobId} satisfies ValidationWorkerRequest);worker.terminate();rejectJob(cancelled());}};
}
