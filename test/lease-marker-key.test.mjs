import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicLeaseKeys} from '../scripts/core/leases.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

test('sensitive lease keys use a stable coordinator-scoped DPAPI HMAC marker',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-marker-key-'));
  const firstScope=path.join(root,'coordinator-a');
  const secondScope=path.join(root,'coordinator-b');
  const secret=providerFixtureToken('openai-project');
  const raw=`file:C:/fixture/${secret}/artifact.json`;
  try{
    const first=publicLeaseKeys([raw],{scopeDir:firstScope})[0];
    const repeated=publicLeaseKeys([raw],{scopeDir:firstScope})[0];
    const otherScope=publicLeaseKeys([raw],{scopeDir:secondScope})[0];
    assert.match(first,/\[REDACTED\]~hmac-sha256-v1-[a-f0-9]{32}-[A-Za-z0-9_-]{43}/);
    assert.equal(first,repeated,'a coordinator must keep one stable opaque marker key across calls');
    assert.notEqual(first,otherScope,'separate physical coordinators must not share an opaque marker key');
    assert.equal(first.includes(secret),false);
    const sealed=path.join(firstScope,'private','lease-marker-hmac-v1.dpapi');
    assert.ok(fs.existsSync(sealed),'the coordinator must persist its DPAPI-sealed marker key');
    assert.equal(fs.readFileSync(sealed,'utf8').includes(secret),false,'the sealed key file must not retain task text');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('existing opaque lease markers fail closed across coordinator, key-loss, and legacy boundaries',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-marker-boundary-'));
  const firstScope=path.join(root,'coordinator-a');
  const secondScope=path.join(root,'coordinator-b');
  const raw=`file:C:/fixture/${providerFixtureToken('openai-project')}/artifact.json`;
  try{
    const marker=publicLeaseKeys([raw],{scopeDir:firstScope})[0];
    publicLeaseKeys([raw],{scopeDir:secondScope});
    assert.throws(()=>publicLeaseKeys([marker],{scopeDir:secondScope}),/LEASE_MARKER_KEY_MISMATCH/,'a marker from another physical coordinator must never be silently reused');
    const firstKey=path.join(firstScope,'private','lease-marker-hmac-v1.dpapi');
    fs.copyFileSync(path.join(secondScope,'private','lease-marker-hmac-v1.dpapi'),firstKey);
    assert.throws(()=>publicLeaseKeys([marker],{scopeDir:firstScope}),/LEASE_MARKER_KEY_MISMATCH/,'a sealed key copied from another coordinator must fail its scope-identity binding');
    fs.rmSync(firstKey);
    assert.throws(()=>publicLeaseKeys([marker],{scopeDir:firstScope}),/LEASE_MARKER_KEY_UNAVAILABLE/,'a missing key must not mint a replacement for an existing marker');
    assert.throws(()=>publicLeaseKeys(['file:C:/fixture/[REDACTED]~sha256-'+ 'a'.repeat(64)+'/artifact.json'],{scopeDir:secondScope}),/LEASE_MARKER_LEGACY_FORMAT/,'pre-HMAC markers require an explicit reconciliation rather than a silent migration');
    assert.throws(()=>publicLeaseKeys(['file:C:/fixture/[REDACTED]/artifact.json'],{scopeDir:secondScope}),/LEASE_MARKER_LEGACY_FORMAT/,'a bare pre-HMAC redaction marker must not enter a new durable lease');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a cached marker key is invalidated when its sealed file changes without a metadata change',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-marker-tamper-'));
  const scope=path.join(root,'coordinator');
  const raw=`file:C:/fixture/${providerFixtureToken('openai-project')}/artifact.json`;
  try{
    const marker=publicLeaseKeys([raw],{scopeDir:scope})[0];
    const sealed=path.join(scope,'private','lease-marker-hmac-v1.dpapi');
    const fixed=new Date(Math.floor(Date.now()/1000)*1000);
    fs.utimesSync(sealed,fixed,fixed);
    publicLeaseKeys([marker],{scopeDir:scope});
    const before=fs.statSync(sealed);
    fs.writeFileSync(sealed,'A'.repeat(before.size),'utf8');
    fs.utimesSync(sealed,before.atime,before.mtime);
    const after=fs.statSync(sealed);
    assert.equal(after.size,before.size,'the tamper probe must preserve file length');
    assert.equal(after.mtimeMs,before.mtimeMs,'the tamper probe must preserve file timestamp');
    assert.throws(()=>publicLeaseKeys([marker],{scopeDir:scope}),/LEASE_MARKER_KEY_UNAVAILABLE/,'cached material must not authorize a marker after its sealed key file was changed');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('an existing opaque marker cannot launder fresh sensitive text into a durable lease key',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-marker-mixed-'));
  const scope=path.join(root,'coordinator');
  const secret=providerFixtureToken('openai-project');
  try{
    const marker=publicLeaseKeys([`file:C:/fixture/${secret}/artifact.json`],{scopeDir:scope})[0];
    const token=marker.match(/\[REDACTED\]~hmac-sha256-v1-[^/]+/)[0];
    const mixed=`file:C:/fixture/${secret}/${token}/artifact.json`;
    assert.throws(()=>publicLeaseKeys([mixed],{scopeDir:scope}),/LEASE_MARKER_MIXED_FORMAT/,'a copied valid marker must not cause a new raw credential segment to bypass projection');
    assert.throws(()=>publicLeaseKeys([mixed.replace(token,'[REDACTED]~sha256-'+ 'a'.repeat(64))],{scopeDir:scope}),/LEASE_MARKER_LEGACY_FORMAT/,'legacy markers must be rejected even when they are mixed with a current marker');
    assert.throws(()=>publicLeaseKeys([`${marker}/[REDACTED]~hmac-sha256-v1-not-a-complete-marker`],{scopeDir:scope}),/LEASE_MARKER_INVALID_FORMAT/,'one valid marker must not hide an adjacent malformed HMAC marker');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
