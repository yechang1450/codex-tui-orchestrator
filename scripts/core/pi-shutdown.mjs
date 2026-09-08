import fs from 'node:fs';
import path from 'node:path';
// Pi's settled event happens after automatic retries/compaction and queued work.
export default function orchestratorCompletion(pi) {
  pi.on('agent_settled',async(_event,ctx)=>{
    if(!ctx.isIdle())return;
    const file=process.env.ORCH_PI_RESULT,token=process.env.ORCH_PI_TOKEN;if(!file||!token)return;
    const messages=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant');
    const last=messages.at(-1)?.message;
    const text=(last?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
    const ok=!['error','aborted'].includes(last?.stopReason)&&text.includes('__ORCH_DONE__ '+token);
    fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({__EXIT__:ok?0:1,__DONE__:true,__REPORT__:text,token}));fs.renameSync(tmp,file);
    ctx.shutdown();
  });
}
