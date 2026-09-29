import {reserve} from './leases.mjs';
import {admissionOk,availableMB,budgetSettings,budgetStateFile,firstRunHeadroom,loadBudgetState,unconsumedReservationMB} from './memory-budget.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Auxiliary visible windows share the exact same atomic reserve as task blocks.
// Waiters have no launcher or registry record until their peak fits.
export async function admitAuxiliaryWindow({coordinator,stateDir,id,keys,env=process.env,available=availableMB,
  reserveLease=reserve,pause=sleep,timeoutMs=21600000}) {
  const budget=budgetSettings(env),state=loadBudgetState(budgetStateFile(stateDir));
  const base=state.samples>0?Math.max(budget.windowCostMB,state.windowCostMB):budget.windowCostMB;
  const costMB=Math.ceil(base*firstRunHeadroom(state.samples,budget.headroom));
  if(available()<=budget.floorMB)throw new Error(`Auxiliary window refused: below mandatory ${budget.floorMB} MB reserve`);
  const rec={id,keys,memoryCostMB:costMB};
  const deadline=Date.now()+Math.max(1,Number(timeoutMs)||1);
  while(true){
    const result=reserveLease(coordinator,rec,Number.MAX_SAFE_INTEGER,undefined,(leases,_candidate,processes)=>
      admissionOk({availableMB:available(),runningCostMB:unconsumedReservationMB(leases,processes),blockCostMB:costMB,floorMB:budget.floorMB}));
    if(result.ok)return {id,coordinator,costMB,floorMB:budget.floorMB};
    if(!['memory','capacity'].includes(result.reason))throw new Error('Auxiliary window admission blocked: '+result.reason);
    if(Date.now()>=deadline)throw new Error('Auxiliary window admission timed out waiting for memory');
    await pause(Math.min(1000,Math.max(1,deadline-Date.now())));
  }
}
