import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readUtf8Bounded} from '../scripts/core/leases.mjs';

test('controller bounded reader reads regular UTF-8 state without allocating past its limit',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'otui-bounded-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.json');fs.writeFileSync(file,'{"ok":true}','utf8');
  assert.equal(readUtf8Bounded(file,'fixture state',32),'{"ok":true}');
});

test('controller bounded reader rejects oversized private state before parsing it',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'otui-bounded-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.json');fs.writeFileSync(file,'x'.repeat(33),'utf8');
  assert.throws(()=>readUtf8Bounded(file,'fixture state',32),/exceeds the 32 byte safety limit/);
});
