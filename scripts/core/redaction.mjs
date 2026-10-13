// Public controller artifacts can survive an interrupted run.  This module keeps
// their diagnostics useful while removing credential-shaped values before they
// cross that durability boundary.  It deliberately does not interpret task
// semantics or alter the in-memory prompt passed to an Agent CLI.
const MAX_TEXT_BYTES=8*1024*1024;
// The former redactor used global regular expressions whose optional prefix
// could retry a credential suffix from each position in a long word.  Task
// prompts are untrusted and may be megabytes long, so all recognition below
// uses a bounded field parser and a single forward scan instead.
const MAX_CREDENTIAL_FIELD_CHARS=512;
const credentialFieldPattern=/^(?:(?:[a-z][a-z0-9]*[_-])+)?(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?id)?|refresh[_-]?token|secret|password|authorization|token|private[_-]?key|(?:database|db)[_-]?(?:url|uri)|connection[_-]?string)$/i;
const publicCredentialField=new RegExp(`^(?:(?:[a-z][a-z0-9]*[_-])+)?(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?id)?|refresh[_-]?token|secret|password|authorization|private[_-]?key|(?:database|db)[_-]?(?:url|uri)|connection[_-]?string)$`,'i');
// This fast cue is only a no-match fast path.  Once a cue is present the
// parser below still examines the complete text, so near-miss adversarial text
// cannot bypass credential detection.
const sensitiveCue=/(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?id)?|refresh[_-]?token|secret|password|authorization|token|private[_-]?key|(?:database|db)[_-]?(?:url|uri)|connection[_-]?string|bearer|sk-(?:proj-|ant-)?|sk_(?:live|test)_|gh[opurs]_|github_pat_)/i;
const runnerSandboxValues=new Set(['read-only','workspace-write','danger-full-access']);
const runnerApprovalValues=new Set(['never','on-request']);

export function isPublicRunnerAuthorization(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const keys=Object.keys(value).sort();
  return keys.length===2&&keys[0]==='approval'&&keys[1]==='sandbox'&&
    runnerSandboxValues.has(value.sandbox)&&runnerApprovalValues.has(value.approval);
}

function isAsciiLetterCode(code){return (code>=65&&code<=90)||(code>=97&&code<=122);}
function isAsciiDigitCode(code){return code>=48&&code<=57;}
function isFieldCharCode(code){return isAsciiLetterCode(code)||isAsciiDigitCode(code)||code===45||code===95;}
function isAsciiWhitespaceCode(code){return code===9||code===10||code===11||code===12||code===13||code===32;}
function isBareTerminatorCode(code){return isAsciiWhitespaceCode(code)||code===44||code===59||code===125||code===93;}
function isBearerTokenCode(code){return isAsciiLetterCode(code)||isAsciiDigitCode(code)||code===46||code===95||code===126||code===43||code===47||code===45||code===61;}
function isProviderTokenCode(code){return isAsciiLetterCode(code)||isAsciiDigitCode(code)||code===45||code===95;}
function isProviderAlnumCode(code){return isAsciiLetterCode(code)||isAsciiDigitCode(code);}
function isGithubPatCode(code){return isAsciiLetterCode(code)||isAsciiDigitCode(code)||code===95;}
function startsIgnoreCase(text,index,needle){return text.length-index>=needle.length&&text.slice(index,index+needle.length).toLowerCase()===needle;}
function skipWhitespace(text,index){while(index<text.length&&isAsciiWhitespaceCode(text.charCodeAt(index)))index++;return index;}
function consumeWhile(text,index,predicate){while(index<text.length&&predicate(text.charCodeAt(index)))index++;return index;}
function credentialFieldName(value){return value.length>0&&value.length<=MAX_CREDENTIAL_FIELD_CHARS&&credentialFieldPattern.test(value);}
function authorizationFieldName(value){const lower=String(value||'').toLowerCase();return lower==='authorization'||lower.endsWith('_authorization')||lower.endsWith('-authorization');}

function readPlainField(text,index){
  const first=text[index];
  if(first==='"'||first==="'"){
    let end=index+1;
    while(end<text.length&&end-index-1<=MAX_CREDENTIAL_FIELD_CHARS){
      if(text[end]===first)return {start:index,name:text.slice(index+1,end),end:end+1,next:end+1,quoted:true};
      if(text[end]==='\\')return {start:index,name:null,end:index+1,next:index+1,quoted:true};
      end++;
    }
    return {start:index,name:null,end:index+1,next:index+1,quoted:true};
  }
  if(!isAsciiLetterCode(text.charCodeAt(index)))return null;
  const end=consumeWhile(text,index,isFieldCharCode);
  const length=end-index;
  return {start:index,name:length<=MAX_CREDENTIAL_FIELD_CHARS?text.slice(index,end):null,end,next:end,quoted:false};
}

function readQuotedValue(text,index,quote){
  let end=index+1;
  while(end<text.length){
    if(text[end]==='\\'){end+=2;continue;}
    if(text[end]===quote)return {start:index+1,end,next:end+1};
    end++;
  }
  return null;
}

function readAssignmentValue(text,field,valueStart){
  const first=text[valueStart];
  if(first==='"'||first==="'"){
    const quoted=readQuotedValue(text,valueStart,first);
    return quoted?{...quoted,markerStart:field.start,markerEnd:quoted.next}:null;
  }
  if(first==='['||first==='\\'||first===undefined)return null;
  if(authorizationFieldName(field)&&startsIgnoreCase(text,valueStart,'bearer')&&isAsciiWhitespaceCode(text.charCodeAt(valueStart+6))){
    const tokenStart=skipWhitespace(text,valueStart+6);
    const tokenEnd=consumeWhile(text,tokenStart,isBearerTokenCode);
    if(tokenEnd>tokenStart)return {start:valueStart,end:tokenEnd,next:tokenEnd,markerStart:field.start,markerEnd:tokenEnd};
  }
  const end=consumeWhile(text,valueStart,code=>!isBareTerminatorCode(code));
  return end>valueStart?{start:valueStart,end,next:end,markerStart:field.start,markerEnd:end}:null;
}

function readPlainAssignment(text,field){
  let index=skipWhitespace(text,field.end);
  if(text[index]!==':'&&text[index]!=='=')return null;
  index=skipWhitespace(text,index+1);
  return readAssignmentValue(text,field.name,index);
}

function escapedQuoteEnd(text,index){
  for(let cursor=index;cursor+1<text.length;){
    if(text[cursor]==='\\'&&text[cursor+1]==='"')return cursor;
    cursor+=text[cursor]==='\\'?2:1;
  }
  return -1;
}

function readEscapedJsonAssignment(text,index){
  if(text[index]!=='\\'||text[index+1]!=='"')return null;
  const keyStart=index+2,keyEnd=escapedQuoteEnd(text,keyStart);
  if(keyEnd<0||keyEnd-keyStart>MAX_CREDENTIAL_FIELD_CHARS)return null;
  const field=text.slice(keyStart,keyEnd);
  if(!credentialFieldName(field))return null;
  let cursor=skipWhitespace(text,keyEnd+2);
  if(text[cursor]!==':')return null;
  cursor=skipWhitespace(text,cursor+1);
  if(text[cursor]!=='\\'||text[cursor+1]!=='"')return null;
  const valueStart=cursor+2,valueEnd=escapedQuoteEnd(text,valueStart);
  return valueEnd<0?null:{start:valueStart,end:valueEnd,next:valueEnd+2,markerStart:index,markerEnd:valueEnd+2};
}

function readBearerToken(text,index){
  if((index>0&&isFieldCharCode(text.charCodeAt(index-1)))||!startsIgnoreCase(text,index,'bearer')||!isAsciiWhitespaceCode(text.charCodeAt(index+6)))return null;
  const start=skipWhitespace(text,index+6),end=consumeWhile(text,start,isBearerTokenCode);
  return end>start?{start,end,next:end,markerStart:index,markerEnd:end}:null;
}

function readStandaloneProviderToken(text,index){
  if(index>0&&isProviderTokenCode(text.charCodeAt(index-1)))return null;
  const variants=[
    ['sk-proj-',isProviderTokenCode],['sk-ant-',isProviderTokenCode],['sk_live_',isProviderTokenCode],['sk_test_',isProviderTokenCode],['sk-',isProviderTokenCode],
    ['ghp_',isProviderAlnumCode],['gho_',isProviderAlnumCode],['ghu_',isProviderAlnumCode],['ghs_',isProviderAlnumCode],['ghr_',isProviderAlnumCode],
    ['github_pat_',isGithubPatCode],
  ];
  for(const [prefix,predicate] of variants){
    if(!startsIgnoreCase(text,index,prefix))continue;
    const start=index+prefix.length,end=consumeWhile(text,start,predicate);
    if(end-start<20)continue;
    if(end<text.length&&isProviderTokenCode(text.charCodeAt(end)))continue;
    return {start:index,end,next:end,markerStart:index,markerEnd:end};
  }
  return null;
}

function redactText(value,marker) {
  const text=String(value??'').slice(0,MAX_TEXT_BYTES);
  if(!sensitiveCue.test(text))return text;
  const chunks=[];let copied=0;
  const replace=match=>{
    const {start,end,markerStart=start,markerEnd=end}=match;
    chunks.push(text.slice(copied,start),marker(text.slice(markerStart,markerEnd)));
    copied=end;
  };
  for(let index=0;index<text.length;){
    const escaped=readEscapedJsonAssignment(text,index);
    if(escaped){replace(escaped);index=escaped.next;continue;}
    const bearer=readBearerToken(text,index);
    if(bearer){replace(bearer);index=bearer.next;continue;}
    const standalone=readStandaloneProviderToken(text,index);
    if(standalone){replace(standalone);index=standalone.next;continue;}
    const ch=text[index];
    if((ch==='"'||ch==="'"||isAsciiLetterCode(text.charCodeAt(index)))&&(ch==='"'||ch==="'"||index===0||!isFieldCharCode(text.charCodeAt(index-1)))){
      const field=readPlainField(text,index);
      if(field?.name&&credentialFieldName(field.name)){
        const assignment=readPlainAssignment(text,field);
        if(assignment){replace(assignment);index=assignment.next;continue;}
      }
      if(field&&!field.quoted&&field.next>index){index=field.next;continue;}
    }
    index++;
  }
  if(!chunks.length)return text;
  chunks.push(text.slice(copied));
  return chunks.join('');
}

export function redactSensitiveText(value) {
  return redactText(value,()=>'[REDACTED]');
}

// Lease keys are public durable identities, so every protected component needs
// a stable opaque discriminator.  It preserves equality and parent/child path
// overlap for the same protected component without retaining the plaintext or
// collapsing unrelated protected paths into one serialized conflict domain.
export function redactSensitiveTextForLeaseKey(value,markerForMatch) {
  if(typeof markerForMatch!=='function')throw new TypeError('Lease-key redaction requires an opaque marker callback');
  return redactText(value,match=>markerForMatch(String(match)));
}

// Durable controller identities and conflict keys cannot be projected in
// place: doing so would make a later resume or overlap comparison point at a
// different object.  Callers use this predicate to reject such identities
// before a controller-owned file is created.
export function isCredentialShapedText(value) {
  const text=String(value??'');
  return redactSensitiveText(text)!==text;
}

export function isPublicCredentialField(key) {
  // A bare `token` is used by the recovery protocol as an opaque attempt
  // identity.  It is not a provider credential field and remains in the
  // controller ledger so existing recovery/integrity contracts stay valid.
  return publicCredentialField.test(String(key??''));
}

function objectKeyProjection(key,entry) {
  const text=String(key??'');
  if(text==='authorization'&&isPublicRunnerAuthorization(entry))return {key:text,changed:false,redactValue:false};
  if(isPublicCredentialField(text))return {key:'[REDACTED]',changed:true,redactValue:true};
  const projected=redactSensitiveText(text);
  return {key:projected,changed:projected!==text,redactValue:false};
}

export function isSensitiveObjectKey(key,entry) {
  return objectKeyProjection(key,entry).changed;
}

function uniquePublicKey(base,output,reserved) {
  if(!Object.hasOwn(output,base)&&!reserved.has(base))return base;
  for(let ordinal=2;;ordinal++) {
    const candidate=base+'#'+ordinal;
    if(!Object.hasOwn(output,candidate)&&!reserved.has(candidate))return candidate;
  }
}

function definePublicEntry(output,key,value) {
  Object.defineProperty(output,key,{value,enumerable:true,configurable:true,writable:true});
}

function project(value,seen) {
  if(typeof value==='string') {
    const projected=redactSensitiveText(value);
    return {value:projected,changed:projected!==value};
  }
  if(value===null||typeof value!=='object')return {value,changed:false};
  if(seen.has(value))throw new Error('Cannot create a public projection from cyclic controller state');
  seen.add(value);
  try {
    if(Array.isArray(value)) {
      let changed=false;
      const entries=value.map(item=>{const result=project(item,seen);changed=changed||result.changed;return result.value;});
      return {value:entries,changed};
    }
    let changed=false;const output={};
    const entries=Object.entries(value).map(([key,entry])=>({key,entry,keyResult:objectKeyProjection(key,entry)}));
    // Reserve every unchanged key first. A secret key that projects to an
    // existing public key receives a deterministic ordinal instead of changing
    // the ordinary key or retaining a raw differentiator.
    const reserved=new Set(entries.filter(({keyResult})=>!keyResult.changed).map(({key})=>key));
    for(const {key,entry,keyResult} of entries) {
      const publicKey=keyResult.changed?uniquePublicKey(keyResult.key,output,reserved):key;
      const result=keyResult.redactValue?{value:'[REDACTED]',changed:true}:project(entry,seen);
      definePublicEntry(output,publicKey,result.value);
      changed=changed||keyResult.changed||publicKey!==key||result.changed;
    }
    return {value:output,changed};
  } finally {seen.delete(value);}
}

export function redactedProjection(value) {
  return project(value,new WeakSet());
}

export function redactDeep(value) {
  return redactedProjection(value).value;
}
