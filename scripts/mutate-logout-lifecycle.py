#!/usr/bin/env python3
"""Directed logout state mutations in a disposable copy. No build, provider network or session IO."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tempfile
p=argparse.ArgumentParser();p.add_argument('--report',required=True);a=p.parse_args()
source=pathlib.Path(__file__).resolve().parents[1];report=pathlib.Path(a.report).resolve();report.mkdir(parents=True,exist_ok=True)
changes=[
 ('logout_generic','statusCode === DisconnectReason.loggedOut ? "requires_link" : "disconnected"','"disconnected"'),
 ('missing_auth_not_latched','if (state === "requires_link") this.lifecycleRequiresLink = true;','if (state === "requires_link") this.lifecycleRequiresLink = false;'),
 ('connecting_downgrades','(state === "connecting" || state === "disconnected")','(state === "disconnected")'),
 ('disconnect_downgrades','(state === "connecting" || state === "disconnected")','(state === "connecting")'),
 ('ready_does_not_clear','if (state === "ready") this.lifecycleRequiresLink = false;','if (state === "ready") this.lifecycleRequiresLink = true;'),
 ('unknown_invents_logout','statusCode === DisconnectReason.loggedOut ? "requires_link" : "disconnected"','"requires_link"'),
 ('old_socket_logout','          if (socketGeneration !== this.socketGeneration) return;','          // Mutant: accept obsolete socket.'),
 ('replacement_forgets_known_auth','    this.lifecycleSnapshot = null;','    this.lifecycleSnapshot = null; this.lifecycleRequiresLink = false;'),
]
with tempfile.TemporaryDirectory(prefix='provider-logout-mutants-') as d:
 root=pathlib.Path(d)
 for name in ['src','__tests__']:shutil.copytree(source/name,root/name)
 for name in ['package.json','tsconfig.json','jest.config.ts']:shutil.copy2(source/name,root/name)
 (root/'node_modules').symlink_to(source/'node_modules',target_is_directory=True)
 cmd=['node',str(source/'node_modules/jest/bin/jest.js'),'--runInBand','--no-cache','--runTestsByPath','__tests__/providerLifecycle.test.ts']
 def run(name):
  r=subprocess.run(cmd,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
  (report/(name+'.log')).write_text(r.stdout)
  if r.returncode==0:return 'passed'
  return 'killed' if 'Tests:       ' in r.stdout and ' failed,' in r.stdout and 'Test suite failed to run' not in r.stdout else 'error'
 assert run('baseline')=='passed'
 f=root/'src/bailey.ts';original=f.read_text();rows=[]
 for name,old,new in changes:
  assert original.count(old)==1,(name,original.count(old))
  f.write_text(original.replace(old,new,1))
  try:status=run(name)
  finally:f.write_text(original)
  rows.append({'name':name,'status':'survived' if status=='passed' else status})
 result={'sourceSha256':hashlib.sha256(original.encode()).hexdigest(),'baseline':'18 passed','mutants':rows}
 (report/'summary.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
 assert all(r['status']=='killed' for r in rows)
