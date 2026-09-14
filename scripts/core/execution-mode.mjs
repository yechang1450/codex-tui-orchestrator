const EXECUTION_MODES=new Set(['headless','visible']);
const TUI_MODES=new Set(['wt','conhost','inactive']);
export function resolveTuiMode(value='wt') {
  const mode=String(value||'wt').trim().toLowerCase();
  if(!TUI_MODES.has(mode))throw new Error('Invalid ORCH_TUI: '+mode+'; expected wt, conhost or inactive');
  return mode;
}

export function resolveExecutionMode(command='',env=process.env,savedMode) {
  let mode;
  if(command==='--resume-run')mode=savedMode??'visible';
  else if(['--run-windows','--visible','--spawn'].includes(command))mode='visible';
  else if(['--exec','--headless'].includes(command))mode='headless';
  else mode=env.ORCH_EXEC_MODE||'headless';
  if(!EXECUTION_MODES.has(mode))throw new Error('Invalid execution mode: '+mode+'; expected headless or visible');
  return mode;
}

// exec has no interactive -a option. Preserve never through the config entry
// while retaining the caller's sandbox, model, working directory and network args.
export function buildExecArgs(interactiveArgs) {
  const args=['exec'];
  for(let i=0;i<interactiveArgs.length;i++){
    if(['-a','--ask-for-approval'].includes(interactiveArgs[i])){
      if(interactiveArgs[++i]!=='never')throw new Error('Headless execution requires approval_policy=never');
    }else args.push(interactiveArgs[i]);
  }
  return [...args,'-c','approval_policy="never"','--json','--color','never','--skip-git-repo-check'];
}
