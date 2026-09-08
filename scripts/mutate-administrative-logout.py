#!/usr/bin/env python3
"""Directed logout state mutations in a disposable copy. No build, provider network or session IO."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tempfile
p=argparse.ArgumentParser();p.add_argument('--report',required=True);a=p.parse_args()
source=pathlib.Path(__file__).resolve().parents[1];report=pathlib.Path(a.report).resolve();report.mkdir(parents=True,exist_ok=True)
changes=[
 ('ignore_pending_recovery', 'administrativeLogout.ts', 'const pending = await readJournal(pendingPath)', 'const pending: Journal | undefined = undefined'),
 ('delete_foreign_json', 'administrativeLogout.ts', 'entry.isFile() && isAuthFile(entry.name)', "entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.provider-migration-')"),
 ('do_not_reclaim_own_partial', 'administrativeLogout.ts', 'await validate(); await fs.unlink(pendingPath); return undefined', 'await validate(); return undefined'),
 ('wrong_remote_ack', 'administrativeLogout.ts', "result.attrs.id !== remoteAckId", 'false'),
 ('error_is_ack', 'administrativeLogout.ts', "result.attrs.type !== 'result'", 'false'),
 ('expired_grant', 'administrativeLogout.ts', 'grant.expiresAt <= Date.now()', 'false'),
 ('wrong_generation', 'administrativeLogout.ts', 'grant[key] !== identity[key]', "key !== 'generation' && grant[key] !== identity[key]"),
 ('blind_retry', 'administrativeLogout.ts', "if (journal?.stage === 'attempted') return { result: 'uncertain' }", "if (journal?.stage === 'attempted') journal = undefined"),
 ('skip_cleanup_reauthorization', 'administrativeLogout.ts', '        await validate()\n        if (journal.stage', '        if (journal.stage'),
 ('new_writes_after_quiesce', 'administrativeAuthWrites.ts', "if (this.closed) throw new Error('AUTH_WRITES_QUIESCED')", '// mutate: allow writes'),
 ('skip_inflight_drain', 'administrativeAuthWrites.ts', 'await Promise.allSettled([...this.pending])', '// mutate: skip drain'),
 ('forget_writer_error', 'administrativeAuthWrites.ts', "if (this.failed) throw new Error('AUTH_WRITE_FAILED')", '// mutate: ignore error'),
]

with tempfile.TemporaryDirectory(prefix='provider-logout-mutants-') as d:
 root=pathlib.Path(d)
 for name in ['src','__tests__']:shutil.copytree(source/name,root/name)
 for name in ['package.json','tsconfig.json','jest.config.ts']:shutil.copy2(source/name,root/name)
 (root/'node_modules').symlink_to(source/'node_modules',target_is_directory=True)
 cmd=['node',str(source/'node_modules/jest/bin/jest.js'),'--runInBand','--no-cache','--runTestsByPath','__tests__/administrativeLogout.test.ts','__tests__/administrativeAuthWrites.test.ts']
 def run(name):
  r=subprocess.run(cmd,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
  (report/(name+'.log')).write_text(r.stdout)
  if r.returncode==0:return 'passed'
  return 'killed' if 'Tests:       ' in r.stdout and ' failed,' in r.stdout and 'Test suite failed to run' not in r.stdout else 'error'
 assert run('baseline')=='passed'
 rows=[]
 for name,file,old,new in changes:
  f=root/'src'/file;original=f.read_text()
  assert original.count(old)==1,(name,original.count(old))
  f.write_text(original.replace(old,new,1))
  try:status=run(name)
  finally:f.write_text(original)
  rows.append({'name':name,'status':'survived' if status=='passed' else status})
 result={'baseline':'passed','mutants':rows}
 (report/'summary.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
 assert all(r['status']=='killed' for r in rows)
