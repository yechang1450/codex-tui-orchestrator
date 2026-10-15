import test from 'node:test';
import assert from 'node:assert/strict';
import {controllerEnvironment} from '../scripts/core/windows-system.mjs';
import {trustedPowerShellEnvironment} from '../scripts/core/private-root.mjs';

const windows=process.platform==='win32';

function withEnvironment(name,value,run){
  const previous=process.env[name];
  if(value===undefined)delete process.env[name];else process.env[name]=value;
  try{return run();}
  finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
}

// Some hosted images make PowerShell 5.1 module auto-loading (and therefore
// Add-Type) stall for tens of seconds unless the caller's module analysis
// cache location is visible to the helper. Only a plain local absolute path
// may pass through, and the ambient module search path must stay excluded.
test('controller environment passes a local module analysis cache path through to helpers',{skip:!windows},()=>{
  withEnvironment('PSModuleAnalysisCachePath','C:\\Users\\public\\ModuleAnalysisCache',()=>{
    const env=controllerEnvironment();
    assert.equal(env.PSModuleAnalysisCachePath,'C:\\Users\\public\\ModuleAnalysisCache');
  });
});

test('controller environment rejects relative or network module analysis cache paths',{skip:!windows},()=>{
  for(const value of ['relative\\cache','\\\\server\\share\\cache','/unix/style']){
    withEnvironment('PSModuleAnalysisCachePath',value,()=>{
      const env=controllerEnvironment();
      assert.equal(env.PSModuleAnalysisCachePath,undefined,`must refuse ${value}`);
    });
  }
});

test('controller environment omits the module cache when the caller has none',{skip:!windows},()=>{
  withEnvironment('PSModuleAnalysisCachePath',undefined,()=>{
    const env=controllerEnvironment();
    assert.equal(env.PSModuleAnalysisCachePath,undefined);
  });
});

test('ambient module search paths still never reach helper processes',{skip:!windows},()=>{
  withEnvironment('PSModulePath','C:\\untrusted\\PowerShell\\Modules',()=>{
    const env=controllerEnvironment();
    assert.equal(Object.keys(env).map(name=>name.toUpperCase()).includes('PSMODULEPATH'),false);
  });
});

test('narrow PowerShell environment carries the same local module analysis cache path',{skip:!windows},()=>{
  withEnvironment('PSModuleAnalysisCachePath','D:\\cache\\ModuleAnalysisCache',()=>{
    assert.equal(trustedPowerShellEnvironment().PSModuleAnalysisCachePath,'D:\\cache\\ModuleAnalysisCache');
  });
  for(const value of ['relative\\cache','\\\\server\\share\\cache','/unix/style']){
    withEnvironment('PSModuleAnalysisCachePath',value,()=>{
      assert.equal(trustedPowerShellEnvironment().PSModuleAnalysisCachePath,undefined,`must refuse ${value}`);
    });
  }
  withEnvironment('PSModuleAnalysisCachePath',undefined,()=>{
    assert.equal(trustedPowerShellEnvironment().PSModuleAnalysisCachePath,undefined);
  });
});
