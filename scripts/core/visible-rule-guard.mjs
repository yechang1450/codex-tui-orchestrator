#!/usr/bin/env node
// Last preflight in the visible worker's own launcher process. The controller
// performs earlier checks too; this narrows the interval before interactive
// Codex loads its supported user/project exec-policy layers.
import path from 'node:path';
import {assertVisibleRuleBoundary,resolveCodexHomeFromWorkspace} from './rule-boundary.mjs';

const [workspace,codexHome,...extra]=process.argv.slice(2);
if(extra.length||typeof workspace!=='string'||!workspace.trim()||!path.isAbsolute(workspace)){
  throw new Error('VISIBLE_EXEC_POLICY_RULES_UNSAFE: visible rule guard requires an absolute worker workspace.');
}
const resolvedCodexHome=resolveCodexHomeFromWorkspace(codexHome,workspace);
assertVisibleRuleBoundary({workspace,codexHome:resolvedCodexHome});
