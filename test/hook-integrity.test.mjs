import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runtimeInventory, verifyRelease, coreInventory} from '../scripts/release-integrity.mjs';

test('runtime seal rejects a changed executable session hook', () => {
  const parent=fileURLToPath(new URL('../temp/',import.meta.url));
  fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'hook-seal-'));
  try {
    for(const dir of ['.codex-plugin','skills','scripts/core','hooks'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    fs.writeFileSync(path.join(root,'repair.mjs'),'// fixture\n','utf8');
    fs.writeFileSync(path.join(root,'scripts/core/orchestrate-sdk.mjs'),'// fixture\n','utf8');
    fs.writeFileSync(path.join(root,'scripts/core/contracts.mjs'),'// fixture\n','utf8');
    const hook=path.join(root,'hooks/session-start.ps1');
    fs.writeFileSync(hook,'Write-Output ready\n','utf8');
    const snapshot=runtimeInventory(root);
    assert.equal(snapshot['hooks/session-start.ps1'],crypto.createHash('sha256').update('Write-Output ready\n').digest('hex'));
    fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion:'fixture',files:coreInventory(root),runtimeFiles:snapshot}),'utf8');
    verifyRelease(root);
    fs.appendFileSync(hook,'Write-Output changed\n','utf8');
    assert.throws(()=>verifyRelease(root),/RELEASE_INTEGRITY_FAILED/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
