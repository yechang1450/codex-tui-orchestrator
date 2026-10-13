import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {redactSensitiveText,redactSensitiveTextForLeaseKey,redactDeep,redactedProjection,isCredentialShapedText} from '../scripts/core/redaction.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

test('redaction keeps a 2 MiB ordinary prompt exact within a bounded worker while still removing credentials', {timeout:6000},()=>{
  const secret=providerFixtureToken('openai-named','large-prompt-regression-fixture');
  const moduleUrl=new URL('../scripts/core/redaction.mjs',import.meta.url).href;
  const worker=`
    import {redactDeep,redactSensitiveText} from ${JSON.stringify(moduleUrl)};
    const ordinary='A'.repeat(2*1024*1024);
    const triggerLike='api_keyish-'.repeat(Math.ceil((2*1024*1024)/11)).slice(0,2*1024*1024);
    const credentialed='prefix OPENAI_API_KEY='+${JSON.stringify(secret)}+' suffix';
    const ordinaryResult=redactDeep({prompt:ordinary}).prompt;
    const triggerLikeResult=redactSensitiveText(triggerLike);
    const credentialResult=redactSensitiveText(credentialed);
    console.log(JSON.stringify({ordinaryExact:ordinaryResult===ordinary,triggerLikeExact:triggerLikeResult===triggerLike,secretRedacted:!credentialResult.includes(${JSON.stringify(secret)}),credentialResult}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',worker],{
    encoding:'utf8',timeout:4000,maxBuffer:64*1024,windowsHide:true,
  });
  assert.equal(result.error,undefined,`redaction worker exceeded the bounded runtime: ${result.error?.code||result.stderr}`);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.ordinaryExact,true,'ordinary prompt text must round-trip exactly');
  assert.equal(output.triggerLikeExact,true,'trigger-like ordinary text must remain bounded and exact');
  assert.equal(output.secretRedacted,true,'credential-shaped content must still be redacted');
  assert.match(output.credentialResult,/OPENAI_API_KEY=\[REDACTED\]/);
});

test('redaction removes provider-prefixed credentials from text without changing ordinary task language',()=>{
  const secret=providerFixtureToken('openai-named','public-projection-do-not-retain');
  const source=`clean generated files; OPENAI_API_KEY="${secret}"; keep the build report`;
  const redacted=redactSensitiveText(source);
  assert.equal(redacted.includes(secret),false);
  assert.match(redacted,/clean generated files/);
  assert.match(redacted,/keep the build report/);
  assert.match(redacted,/OPENAI_API_KEY="\[REDACTED\]"/);
});

test('redaction recognizes AWS and database credential fields without changing ordinary task language',()=>{
  const secrets={
    awsAccessKeyId:'aws-access-key-id-fixture',
    awsSecretAccessKey:'aws-secret-access-key-fixture',
    databaseUrl:'postgresql://demo:fixture-password@db.example.invalid:5432/app',
  };
  const source=`keep the task; AWS_ACCESS_KEY_ID=${secrets.awsAccessKeyId}; AWS_SECRET_ACCESS_KEY="${secrets.awsSecretAccessKey}"; DATABASE_URL=${secrets.databaseUrl}; preserve this note`;
  const redacted=redactSensitiveText(source);
  for(const secret of Object.values(secrets))assert.equal(redacted.includes(secret),false,`redaction retained ${secret}`);
  assert.match(redacted,/AWS_ACCESS_KEY_ID=\[REDACTED\]/);
  assert.match(redacted,/AWS_SECRET_ACCESS_KEY="\[REDACTED\]"/);
  assert.match(redacted,/DATABASE_URL=\[REDACTED\]/);
  assert.match(redacted,/keep the task/);
  assert.match(redacted,/preserve this note/);
});

test('deep projection redacts nested credential fields and credential-shaped text without mutating the live state',()=>{
  const secrets={openai:providerFixtureToken('openai-named','nested-openai-do-not-retain'),github:providerFixtureToken('github-named','nested-github-do-not-retain')};
  const live={
    request:`perform task with GITHUB_TOKEN=${secrets.github}`,
    tasks:[{id:'T001',prompt:`OPENAI_API_KEY=${secrets.openai}; ordinary task text`}],
    diagnostics:{OPENAI_API_KEY:secrets.openai,ordinary:'preserve this'},
    nested:[{authorization:`Bearer ${secrets.github}`}],
  };
  const projected=redactDeep(live),serialized=JSON.stringify(projected);
  for(const secret of Object.values(secrets))assert.equal(serialized.includes(secret),false,`projection retained ${secret}`);
  assert.equal(Object.hasOwn(projected.diagnostics,'OPENAI_API_KEY'),false);
  assert.equal(projected.diagnostics['[REDACTED]'],'[REDACTED]');
  assert.equal(projected.diagnostics.ordinary,'preserve this');
  assert.match(projected.tasks[0].prompt,/ordinary task text/);
  assert.equal(live.diagnostics.OPENAI_API_KEY,secrets.openai);
  assert.match(live.request,new RegExp(secrets.github));
});

test('projection change tracking distinguishes ordinary ledgers from ledgers that require private recovery state',()=>{
  const ordinary=redactedProjection({request:'clean temporary files',tasks:[{id:'T001',prompt:'remove .tmp'}]});
  assert.equal(ordinary.changed,false);
  assert.deepEqual(ordinary.value,{request:'clean temporary files',tasks:[{id:'T001',prompt:'remove .tmp'}]});
  const sensitive=redactedProjection({request:'Authorization: Bearer abc-private-token'});
  assert.equal(sensitive.changed,true);
  assert.equal(JSON.stringify(sensitive.value).includes('abc-private-token'),false);
});

test('redaction recognizes standalone provider tokens without changing ordinary lookalikes',()=>{
  const openai=providerFixtureToken('openai-project');
  const legacyOpenai=providerFixtureToken('openai-legacy','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
  const anthropic=providerFixtureToken('anthropic','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
  const github=providerFixtureToken('github-classic','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
  const source=`retain ${openai}, ${legacyOpenai}, ${anthropic}, and ${github}; keep the sk-project migration, sk-short-note, and ghp_notes label`;
  const projected=redactedProjection(source);
  assert.equal(projected.changed,true);
  assert.equal(projected.value.includes(openai),false);
  assert.equal(projected.value.includes(legacyOpenai),false);
  assert.equal(projected.value.includes(anthropic),false);
  assert.equal(projected.value.includes(github),false);
  assert.match(projected.value,/sk-project migration/);
  assert.match(projected.value,/sk-short-note/);
  assert.match(projected.value,/ghp_notes label/);
});

test('redaction recognizes underscore-bearing legacy sk_live provider tokens',()=>{
  const secret=`sk_live_${'abcdefghijklmnopqrstuvwxyz012345'.repeat(2)}`;
  const source=`preserve the task wording; credential ${secret}; preserve the report`;
  const redacted=redactSensitiveText(source);
  assert.equal(isCredentialShapedText(secret),true,'a standalone sk_live token must be rejected as credential-shaped');
  assert.equal(redacted.includes(secret),false,'the underscore-bearing token must not reach a public projection');
  assert.match(redacted,/preserve the task wording/);
  assert.match(redacted,/preserve the report/);
  assert.equal(redactedProjection({prompt:source}).changed,true,'a prompt containing the token must request private recovery handling');
});

test('opaque lease-key redaction binds the assignment context as well as the secret value',()=>{
  const secret='same-private-value';
  const marker=value=>'[opaque:'+crypto.createHash('sha256').update(value).digest('hex')+']';
  const api=redactSensitiveTextForLeaseKey('api_key='+secret,marker);
  const token=redactSensitiveTextForLeaseKey('token='+secret,marker);
  assert.notEqual(api,token,'different protected key/value components must not collapse to one durable conflict marker');
  assert.equal(api,redactSensitiveTextForLeaseKey('api_key='+secret,marker),'the same component must remain stable');
  assert.equal(api.includes(secret)||token.includes(secret),false);
});

test('deep projection preserves only the exact nonsecret runner authorization policy shape',()=>{
  const token=providerFixtureToken('github-classic','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
  const projected=redactDeep({
    authorization:{sandbox:'workspace-write',approval:'never'},
    authorizationHeader:{authorization:`Bearer ${token}`},
    Authorization:{sandbox:'workspace-write',approval:'never'},
    token,
    nested:{authorization:{sandbox:'workspace-write',approval:'never',api_key:token}},
    unsupported:{authorization:{sandbox:'workspace-write',approval:'ask'}},
  });
  assert.deepEqual(projected.authorization,{sandbox:'workspace-write',approval:'never'});
  assert.equal(Object.hasOwn(projected.authorizationHeader,'authorization'),false);
  assert.equal(projected.authorizationHeader['[REDACTED]'],'[REDACTED]');
  assert.equal(Object.hasOwn(projected,'Authorization'),false);
  assert.equal(projected['[REDACTED]'],'[REDACTED]');
  assert.equal(projected.token,'[REDACTED]');
  assert.equal(Object.hasOwn(projected.nested,'authorization'),false);
  assert.equal(projected.nested['[REDACTED]'],'[REDACTED]');
  assert.equal(Object.hasOwn(projected.unsupported,'authorization'),false);
  assert.equal(projected.unsupported['[REDACTED]'],'[REDACTED]');
});

test('deep projection redacts credential-shaped object keys with deterministic public collision names',()=>{
  const secretKey=providerFixtureToken('openai-project');
  const live={
    type:'json',
    [secretKey]:'ordinary keyed proof',
    '[REDACTED]':'existing public marker',
    api_key:'value must not survive a credential field',
    token:'opaque-attempt-identity',
    authorization:{sandbox:'read-only',approval:'on-request'},
  };
  const projected=redactedProjection(live);
  const encoded=JSON.stringify(projected.value);
  assert.equal(projected.changed,true);
  assert.equal(encoded.includes(secretKey),false);
  assert.equal(Object.hasOwn(projected.value,secretKey),false);
  assert.equal(Object.hasOwn(projected.value,'api_key'),false);
  assert.equal(projected.value['[REDACTED]'],'existing public marker');
  assert.equal(projected.value['[REDACTED]#2'],'ordinary keyed proof');
  assert.equal(projected.value['[REDACTED]#3'],'[REDACTED]');
  assert.equal(projected.value.token,'opaque-attempt-identity');
  assert.deepEqual(projected.value.authorization,{sandbox:'read-only',approval:'on-request'});
  assert.equal(projected.value.type,'json');
});
