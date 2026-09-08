#!/usr/bin/env python3
"""Real incoming-gate substitutions in an isolated provider copy; no builds/install."""
import hashlib, json, pathlib, shutil, subprocess, sys, tempfile
SOURCE=pathlib.Path(__file__).resolve().parent.parent
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='provider-incoming-mutations-'))
for directory in ['src','__tests__']:
 shutil.copytree(SOURCE/directory,ROOT/directory)
for filename in ['package.json','tsconfig.json','jest.config.ts']:
 shutil.copy2(SOURCE/filename,ROOT/filename)
(ROOT/'node_modules').symlink_to(SOURCE/'node_modules',target_is_directory=True)
FILE='src/bailey.ts'
TEST='__tests__/incomingLifecycleGate.test.ts'
BRANCH='if (this.lifecycleIncomingGate) await this.lifecycleIncomingGate(payload, dispatch);\n            else dispatch();'
CASES=[
 ('incoming-gate-not-installed','this.lifecycleIncomingGate = gate;','this.lifecycleIncomingGate = null;'),
 ('dedup-before-awaited-admission','const dispatch = () => {\n              if (this.lifecycleStopped || !processDuplicate()) return false;','const prematureDuplicate = processDuplicate();\n            const dispatch = () => {\n              if (this.lifecycleStopped || !prematureDuplicate) return false;'),
 ('gate-error-silently-acknowledged',BRANCH,'if (this.lifecycleIncomingGate) await this.lifecycleIncomingGate(payload, dispatch).catch(() => false);\n            else dispatch();'),
 ('gate-denial-followed-by-dispatch',BRANCH,'if (this.lifecycleIncomingGate) { await this.lifecycleIncomingGate(payload, dispatch); dispatch(); }\n            else dispatch();'),
 ('late-socket-stop-ignored','if (this.lifecycleStopped || !processDuplicate()) return false;','if (!processDuplicate()) return false;'),
 ('concurrent-duplicate-emitted-twice','if (this.lifecycleStopped || !processDuplicate()) return false;','if (this.lifecycleStopped) return false;'),
]
def run():
 return subprocess.run(['node','node_modules/jest/bin/jest.js','--runTestsByPath',TEST,'--runInBand','--silent','--forceExit'],cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
paths=[FILE,TEST,'package.json','tsconfig.json','jest.config.ts']
hashes={p:sha(SOURCE/p) for p in paths}
baseline=run()
if baseline.returncode:print(baseline.stdout);raise SystemExit('Baseline not green')
original=(ROOT/FILE).read_text();results=[]
for name,old,new in CASES:
 # Two event paths share this gate branch; select only the normal-message occurrence.
 expected=2 if old==BRANCH else 1
 if original.count(old)!=expected:raise SystemExit(f'Unexpected anchor count {name}: {original.count(old)}')
 try:
  (ROOT/FILE).write_text(original.replace(old,new,1))
  try:
   result=run()
   assertion_failure=result.returncode==1 and 'Test Suites:' in result.stdout and 'FAIL ' in result.stdout and 'error TS' not in result.stdout and 'Test suite failed to run' not in result.stdout and 'Exceeded timeout' not in result.stdout
   status='killed' if assertion_failure else 'survived' if result.returncode==0 else 'error'
   results.append({'mutant':name,'status':status,'exitCode':result.returncode,'output':result.stdout})
  except subprocess.TimeoutExpired:
   results.append({'mutant':name,'status':'timeout'})
  print(name+': '+results[-1]['status'],flush=True)
 finally:(ROOT/FILE).write_text(original)
unchanged=hashes=={p:sha(SOURCE/p) for p in paths}
report={'sourceHashes':hashes,'sourceUnchanged':unchanged,'results':results}
out=SOURCE/'reports/mutation/incoming-lifecycle.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2))
print(f"{sum(r['status']=='killed' for r in results)}/{len(results)} killed; source unchanged={unchanged}")
sys.exit(0 if unchanged and all(r['status']=='killed' for r in results) else 1)
