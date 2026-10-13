// This entry point exists only for lifecycle fixtures. Production workers are
// always started through scripts/core/headless-worker.mjs, whose defaults bind
// Codex argv and publisher identity at final spawn.
import {register} from 'node:module';

register(new URL('./headless-worker-fixture-loader.mjs',import.meta.url));
const {runHeadlessWorker}=await import('../scripts/core/headless-worker.mjs?fixture');

runHeadlessWorker(process.argv[2]).then(result=>{
  if(result?.childStillRunning===true&&result?.exitUnproven===true)process.exit(0);
}).catch(error=>{console.error(error);process.exitCode=1;});
