// Test-only credential fixtures are assembled at runtime so repository secret
// scanners see neither complete provider-shaped values nor accidental samples.
// Each returned value intentionally satisfies the redaction patterns exercised
// by the tests that import this helper.
const hyphen=String.fromCharCode(45);
const underscore=String.fromCharCode(95);
const openAiPrefix=String.fromCharCode(115,107);
const githubClassicPrefix=String.fromCharCode(103,104,112);

export const providerFixtureSuffix='abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function providerFixtureToken(kind,suffix=providerFixtureSuffix){
  const payload=String(suffix);
  switch(kind){
    case 'openai-project':return [openAiPrefix,'proj',payload].join(hyphen);
    case 'openai-legacy':return [openAiPrefix,payload].join(hyphen);
    case 'anthropic':return [openAiPrefix,'ant','api03',payload].join(hyphen);
    case 'github-classic':return [githubClassicPrefix,payload].join(underscore);
    case 'openai-named':return [openAiPrefix,payload].join(hyphen);
    case 'github-named':return [githubClassicPrefix,payload].join(hyphen);
    default:throw new TypeError(`Unknown provider fixture token kind: ${kind}`);
  }
}
