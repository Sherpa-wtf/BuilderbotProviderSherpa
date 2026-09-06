#!/usr/bin/env python3
"""Run focused real-source QR/socket mutants against behavior tests, restoring every source."""
import json, pathlib, subprocess, sys, tempfile, shutil
SOURCE = pathlib.Path(__file__).resolve().parent.parent
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='provider-lifecycle-mutants-'))
for folder in ['src','__tests__']:shutil.copytree(SOURCE/folder,ROOT/folder)
for filename in ['package.json','tsconfig.json','jest.config.ts']:shutil.copy2(SOURCE/filename,ROOT/filename)
(ROOT/'node_modules').symlink_to(SOURCE/'node_modules',target_is_directory=True)
CASES = [
 ('qr-expiry-inclusive', 'src/qrChallenge.ts', 'this.now() >= this.artifact.expiresAt', 'this.now() > this.artifact.expiresAt'),
 ('qr-publication-expired', 'src/qrChallenge.ts', 'this.now() >= expiresAt', 'false'),
 ('qr-late-render-overwrites', 'src/qrChallenge.ts', 'revision !== this.revision', 'false'),
 ('qr-old-socket-allowed', 'src/qrChallenge.ts', 'if (generation !== this.generation) return null', 'if (false) return null'),
 ('qr-invalidation-keeps-artifact', 'src/qrChallenge.ts', 'this.artifact = null', '// this.artifact = null'),
 ('socket-stop-not-closed', 'src/bailey.ts', 'this.vendor?.end(new Error("Intentional lifecycle stop"));', '// omitted socket end'),
 ('socket-obsolete-allowed', 'src/bailey.ts', 'if (socketGeneration !== this.socketGeneration) return;\n          const {', 'if (false) return;\n          const {'),
 ('pause-during-authority-check-ignored', 'src/bailey.ts', 'this.assertSocketCurrent(socketGeneration);\n            return sendMessage(...args);', 'return sendMessage(...args);'),
 ('recovery-latches-pause', 'src/bailey.ts', 'public recoverLifecycle(): void {', 'public recoverLifecycle(): void { this.lifecycleStopped = true;'),
 ('qr-previous-boot-accepted', 'src/bailey.ts', 'query.qrInstanceId !== this.qrInstanceId || ', ''),
 ('send-authority-not-checked', 'src/bailey.ts', 'await this.lifecycleGuard?.();', '// omitted lifecycle guard'),
]
CMD=['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath','__tests__/qrChallenge.test.ts','__tests__/providerLifecycle.test.ts','--forceExit','--silent']
def run(): return subprocess.run(CMD,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
baseline=run()
if baseline.returncode: print(baseline.stdout);raise SystemExit('baseline not green')
results=[]
for name,filename,old,new in CASES:
 path=ROOT/filename;original=path.read_text()
 if original.count(old)!=1:raise SystemExit('mutation site not unique: '+name)
 try:
  path.write_text(original.replace(old,new,1)); result=run()
  killed=result.returncode==1 and 'Test Suites:' in result.stdout and 'FAIL ' in result.stdout and 'error TS' not in result.stdout and 'Test suite failed to run' not in result.stdout and 'Exceeded timeout' not in result.stdout
  results.append({'mutant':name,'file':filename,'status':'killed' if killed else 'survived_or_error','exitCode':result.returncode,'output':result.stdout})
  print(name+': '+results[-1]['status'],flush=True)
 finally:path.write_text(original)
out=SOURCE/'reports/mutation/lifecycle-semantic.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(results,indent=2))
print(str(sum(r['status']=='killed' for r in results))+'/'+str(len(results))+' targeted mutants killed')
sys.exit(0 if all(r['status']=='killed' for r in results) else 1)
