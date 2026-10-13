import {randomUUID} from 'node:crypto';
import {bind,prepare,release,reservationAcknowledgement,reserve} from './leases.mjs';
import {admissionOk,availableMB,budgetSettings,budgetStateFile,firstRunHeadroom,loadBudgetState,unconsumedReservationMB} from './memory-budget.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const admissions=new WeakMap();
const LEASE_INSTANCE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function auxiliaryCapability(admission) {
  const state=admissions.get(admission);
  if(!state||!admission||typeof admission.coordinator!=='string'||typeof admission.id!=='string')
    throw new Error('Auxiliary lease lifecycle requires its original in-process admission');
  return state;
}

function auxiliaryLeaseOptions(admission) {
  const state=auxiliaryCapability(admission);
  if(!state.reservationProof)
    throw new Error('Auxiliary lease lifecycle is missing its private reservation acknowledgement');
  return {reservationProof:state.reservationProof};
}

// Auxiliary visible windows share the exact same atomic reserve as task blocks.
// Waiters have no launcher or registry record until their peak fits. The
// durable record carries only public identities; the private reservation proof
// stays in this module and cannot cross a JSON, process, or object-copy boundary.
export async function admitAuxiliaryWindow({coordinator,stateDir,id,keys,env=process.env,available=availableMB,
  reserveLease=reserve,reservationReceipt=reservationAcknowledgement,pause=sleep,timeoutMs=21600000}) {
  const budget=budgetSettings(env),state=loadBudgetState(budgetStateFile(stateDir));
  const base=state.samples>0?Math.max(budget.windowCostMB,state.windowCostMB):budget.windowCostMB;
  const costMB=Math.ceil(base*firstRunHeadroom(state.samples,budget.headroom));
  if(available()<=budget.floorMB)throw new Error(`Auxiliary window refused: below mandatory ${budget.floorMB} MB reserve`);
  const runId=randomUUID();
  const rec={id,runId,keys,memoryCostMB:costMB};
  const deadline=Date.now()+Math.max(1,Number(timeoutMs)||1);
  while(true){
    const result=reserveLease(coordinator,rec,Number.MAX_SAFE_INTEGER,undefined,(leases,_candidate,processes)=>
      admissionOk({availableMB:available(),runningCostMB:unconsumedReservationMB(leases,processes),blockCostMB:costMB,floorMB:budget.floorMB}));
    if(result.ok){
      const receipt=reservationReceipt(coordinator,id,result);
      if(!receipt||typeof receipt.reservationProof!=='object'||!LEASE_INSTANCE_ID.test(receipt.leaseInstanceId||''))
        throw new Error('Auxiliary window reservation acknowledgement is unavailable; retaining the committed lease for reconciliation');
      const admission=Object.freeze({id,coordinator,costMB,floorMB:budget.floorMB,runId,leaseInstanceId:receipt.leaseInstanceId});
      admissions.set(admission,{reservationProof:receipt.reservationProof,released:false});
      return admission;
    }
    if(!['memory','capacity'].includes(result.reason))throw new Error('Auxiliary window admission blocked: '+result.reason);
    if(Date.now()>=deadline)throw new Error('Auxiliary window admission timed out waiting for memory');
    await pause(Math.min(1000,Math.max(1,deadline-Date.now())));
  }
}

export function prepareAuxiliaryLease(admission,pidFile) {
  return prepare(admission.coordinator,admission.id,pidFile,undefined,auxiliaryLeaseOptions(admission));
}

export function bindAuxiliaryLease(admission,identity) {
  return bind(admission.coordinator,admission.id,identity,undefined,auxiliaryLeaseOptions(admission));
}

export function releaseAuxiliaryLease(admission) {
  const state=auxiliaryCapability(admission);
  if(state.released)return true;
  release(admission.coordinator,admission.id,undefined,auxiliaryLeaseOptions(admission));
  state.released=true;
  return true;
}
