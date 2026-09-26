// Parent-owned inspection is deliberately serialized. A child report or
// checkpoint only schedules work; this queue is the single writer/inspector.
export function createVerificationQueue() {
  let tail=Promise.resolve(),active=0,maxConcurrency=0,started=0,finished=0;
  return {
    enqueue(label,job){
      const sequence=++started;
      const run=tail.then(async()=>{
        active++;maxConcurrency=Math.max(maxConcurrency,active);
        try{return await job({label,sequence});}
        finally{active--;finished++;}
      });
      tail=run.catch(()=>{});
      return run;
    },
    drain(){return tail;},
    stats(){return {started,finished,maxConcurrency};},
  };
}
