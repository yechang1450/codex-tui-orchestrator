import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHECKOUT_MARKETPLACE_NAME} from '../scripts/repair-plugin-registration.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('the GitHub marketplace has a stable public identity while retaining a local relative source',()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'.agents','plugins','marketplace.json'),'utf8'));
  assert.equal(CHECKOUT_MARKETPLACE_NAME,'yechang1450-codex-tui-orchestrator');
  assert.equal(catalog.name,CHECKOUT_MARKETPLACE_NAME);
  assert.equal(catalog.interface?.displayName,'Codex TUI Orchestrator');
  assert.equal(catalog.plugins?.length,1);
  assert.equal(catalog.plugins[0]?.name,'codex-tui-orchestrator');
  assert.deepEqual(catalog.plugins[0]?.source,{source:'local',path:'./'});
});
