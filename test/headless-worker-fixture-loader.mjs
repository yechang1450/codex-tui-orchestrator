// Node's test-only ESM loader substitutes only the two final-spawn trust
// adapters for a query-qualified copy of the real worker module. The worker
// source itself receives no test bypass or injectable authorization API.
const fixtureRoot=new URL('./',import.meta.url);
const fixtureWorker=/\/scripts\/core\/headless-worker\.mjs\?fixture$/;

export async function resolve(specifier,context,nextResolve) {
  if(fixtureWorker.test(context.parentURL||'')) {
    if(specifier==='./worker-authorization.mjs')
      return {url:new URL('./fixtures/fixture-worker-authorization.mjs',fixtureRoot).href,shortCircuit:true};
    if(specifier==='./host-cli.mjs')
      return {url:new URL('./fixtures/fixture-host-cli.mjs',fixtureRoot).href,shortCircuit:true};
  }
  return nextResolve(specifier,context);
}
