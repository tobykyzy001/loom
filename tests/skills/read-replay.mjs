import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { sha256 } from '../../packages/node-client/src/util.js'

// One real HTTP center, one temporary project, and the real deterministic JS
// worker. No direct database mutation, HTTP connector, model or DSH profile.
const checks=[]
const withBrowser=process.argv.includes('--browser')
const record=(name,evidence)=>checks.push({name,status:'PASS',...evidence})
const reject=async(body,predicate)=>{await assert.rejects(body,(error)=> typeof predicate==='function' ? predicate(error) : predicate.test(error.message));return predicate.name||predicate.toString()}
let server,node
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))
try {
  const root=await testingRoot()
  server=await startRustConcierge({root})
  let admin=new LoomHttpClient({baseUrl:server.baseUrl,clientToken:server.clientToken,timeoutMs:15000})
  const projectRoot=await prepareProject(root)
  const initialBytes=await readFile(join(projectRoot,'input.txt'))
  const created=await admin.post('/api/v1/projects',{name:'Synthetic replay source only',root:projectRoot,mode:'read_only'})
  const projectId=created.project.id
  const enrollment=await admin.post('/api/v1/enrollment-codes',{})
  node=await LocalNodeRunner.create({baseUrl:server.baseUrl,stateDir:join(root,'node-state'),artifactDir:join(root,'node-artifacts'),enrollmentCode:enrollment.code,projectRoots:{[projectId]:projectRoot},registration:{workerId:'default',harnessKind:'local-fixture',profileId:'isolated-replay-test'}})
  const binding=await admin.post('/api/v1/project-bindings',{project_id:projectId,node_id:node.nodeId,worker_id:'default',root_scope:projectRoot})
  const grant=await admin.post('/api/v1/grants',{project_id:projectId,project_binding_id:binding.id,node_id:node.nodeId,worker_id:'default',operations:['read']})
  const grantId=grant.grant.id
  const grants=()=>admin.get('/api/v1/grants')
  const tickets=()=>admin.get('/api/v1/tickets')
  const countTickets=async()=> (await tickets()).tickets.length
  const skills=()=>admin.get('/api/v1/candidates')
  const ordinary=(objective)=>admin.post('/api/v1/tickets',{project_id:projectId,node_id:node.nodeId,worker_id:'default',grant_id:grantId,kind:'read_summary',relative_path:'input.txt',objective})
  const settle=async()=>{const result=await node.pollAndRun();await node.client.dispatchOutbox();await node.client.dispatchOutbox();return result}
  const bytes=async(ticket,artifact)=>admin.get(`/api/v1/tickets/${ticket}/artifacts/${artifact}`)
  const candidate=async(name)=> {let result
    for(let index=0;index<3;index++) {result=await admin.post('/api/v1/candidates',{project_id:projectId,kind:'skill',value:name,source_refs:[source.id]})}
    assert.ok(result.candidate?.id,`Three source-bound observations should produce a Skill candidate: ${JSON.stringify(result)}`)
    return result.candidate.id
  }
  const replay=async(id,body)=>admin.post(`/api/v1/candidates/${id}/replay`,body)
  const replayState=async(id)=>admin.get(`/api/v1/candidates/${id}/replay`)
  const accept=async(id)=>admin.request('PATCH',`/api/v1/candidates/${id}`,{decision:'accept',replay_verified:true})
  const assertNoAuthority=async(count,error) => {
    assert.equal(await countTickets(),count)
    assert.equal((await grants()).grants.length,1)
    const view=await skills()
    assert.equal(view.skills.length,0)
    assert.equal((await admin.get('/api/v1/memories')).memories.length,0)
    return {expected_error:error,ticket_total:count,new_grants:0}
  }
  const source=await ordinary('Original real read_summary source for exact replay')
  const result=await settle()
  assert.equal(result.status,'succeeded',JSON.stringify(result))
  let original=await admin.get(`/api/v1/tickets/${source.id}`)
  assert.equal(original.status,'succeeded')
  assert.equal(original.artifacts.length,1)
  assert.equal(original.reports[0].state,'succeeded')
  const [sourceArtifact]=original.artifacts
  assert.equal(sourceArtifact.origin_node_id,node.nodeId)
  assert.equal(sourceArtifact.assignment_id,original.assignments[0].id)
  const sourceDownload=await bytes(source.id,sourceArtifact.id)
  const sourceSha=sha256(sourceDownload.content)
  assert.equal(sourceArtifact.sha256,sourceSha)
  const sourceSummary=JSON.parse(sourceDownload.content)
  assert.equal(sourceSummary.schema,'loom.synthetic_summary.v1')
  assert.equal(sourceSummary.path,'input.txt')
  assert.equal(sourceSummary.lines[0],'Real isolated project input.')
  assert.deepEqual(await readFile(join(projectRoot,'input.txt')),initialBytes)
  record('immutable source with actual Assignment, Report, UUID Artifact and independently computed SHA',{source_ticket_id:source.id,source_artifact_id:sourceArtifact.id,source_sha256:sourceSha,source_worker:original.assignments[0].worker_id,schema:7})

  const candidateId=await candidate('Bounded exact deterministic read_summary')
  assert.equal(await countTickets(),1)
  await reject(accept(candidateId),(error)=>error.status===400 && (error.code==='not_found' || /proof|verified/i.test(error.message)))
  record('raw replay_verified boolean cannot create Memory, Skill, authority or execution',await assertNoAuthority(1,'accept_without_real_proof'))
  await reject(replay(candidateId,{source_ticket_id:'tkt_missing_from_candidate'}),/not actually bound/)
  await reject(replay(candidateId,{source_ticket_id:source.id,root:'/unauthorized',replay_verified:true,artifact_id:sourceArtifact.id}),/only a bounded candidate ID and exact source_ticket_id/)
  await reject(replay('candidate_unknown',{source_ticket_id:source.id}),(error)=>error.status===404)
  record('foreign/unbound source, random candidate and root/artifact override produce no work',await assertNoAuthority(1,'source_scope_and_shallow_body_enforced'))

  if(withBrowser) {
    const { verifySkillsBrowser } = await import('../browser/skills-proof.mjs')
    const evidence=await verifySkillsBrowser({server,admin,node,root,candidateId,source:original,runWorker:settle})
    assert.equal(evidence.actual_ui_replay_confirmed,true)
    assert.equal(evidence.explicit_accept_persisted,true)
    assert.equal(evidence.source_replay_sha_match,true)
    assert.equal(evidence.no_standing_permission,true)
    assert.equal(evidence.narrow_no_overflow,true)
    record('actual Edge replays only real chosen source, waits worker, accepts saved proof',{...evidence,real_worker_invocation:true})
  }

  let issued=await replay(candidateId,{source_ticket_id:source.id})
  assert.equal(issued.status,withBrowser?'verified':'awaiting_execution',JSON.stringify(issued))
  assert.equal(issued.source_ticket_id,source.id)
  assert.notEqual(issued.replay_ticket_id,source.id)
  if(withBrowser) { assert.ok(issued.replay_artifact_id) } else { assert.equal(issued.replay_artifact_id,null) }
  assert.equal(issued.runtime,'bounded_exact_deterministic_read_summary_only')
  assert.equal(issued.authority_created,false)
  assert.equal(await countTickets(),2)
  assert.equal((await replay(candidateId,{source_ticket_id:source.id})).replay_ticket_id,issued.replay_ticket_id)
  assert.equal(await countTickets(),2,'Repeated request cannot create another normal ticket')
  if(!withBrowser) await reject(accept(candidateId),(error)=>error.status===400)
  let waiting=await admin.get(`/api/v1/tickets/${issued.replay_ticket_id}`)
  if(withBrowser) {
    assert.equal(waiting.artifacts.length,1)
    assert.equal(waiting.reports[0].state,'succeeded')
  } else {
    assert.deepEqual(waiting.artifacts,[])
    assert.equal(waiting.reports.length,0)
  }
  assert.equal(waiting.kind,'read_summary')
  assert.equal(waiting.grant_id,grantId)
  assert.equal(waiting.project_id,projectId)
  assert.equal(waiting.node_id,node.nodeId)
  assert.equal(waiting.worker_id,'default')
  assert.notEqual(waiting.assignments[0].id,original.assignments[0].id)
  assert.notEqual(waiting.assignments[0].lease_id,original.assignments[0].lease_id)
  const replayExecution=await settle()
  assert.equal(replayExecution.status,withBrowser?'idle':'succeeded',JSON.stringify(replayExecution))
  const proof=await replayState(candidateId)
  assert.equal(proof.status,'verified',JSON.stringify(proof))
  assert.notEqual(proof.replay_artifact_id,sourceArtifact.id)
  assert.notEqual(proof.replay_ticket_id,source.id)
  assert.equal(proof.current_project_valid,true)
  assert.equal(proof.sample.path,'input.txt')
  assert.deepEqual(proof.sample.lines,sourceSummary.lines)
  const replayDownload=await bytes(issued.replay_ticket_id,proof.replay_artifact_id)
  const freshSha=sha256(replayDownload.content)
  assert.equal(freshSha,sourceSha)
  assert.equal(replayDownload.artifact.sha256,sourceSha)
  assert.deepEqual(Buffer.from(replayDownload.content),Buffer.from(sourceDownload.content))
  assert.equal((await admin.get(`/api/v1/tickets/${issued.replay_ticket_id}`)).reports[0].state,'succeeded')
  assert.notEqual(replayDownload.artifact.assignment_id,sourceArtifact.assignment_id)
  assert.deepEqual(await readFile(join(projectRoot,'input.txt')),initialBytes)
  original=await admin.get(`/api/v1/tickets/${source.id}`)
  assert.equal(original.artifacts[0].sha256,sourceSha)
  assert.equal(original.reports.length,1)
  assert.equal(await countTickets(),2)
  record('fresh ordinary runner output matches actual original bytes AND SHA before any Skill acceptance',{replay_ticket_id:issued.replay_ticket_id,source_sha256:sourceSha,replay_sha256:freshSha,fresh_artifact:proof.replay_artifact_id,ordinary_ticket_total:2,sample:proof.sample,project_unchanged:true})

  const accepted = withBrowser
    ? await reject(accept(candidateId), error => error.status === 400 && /already|repeat|pending/i.test(error.message))
    : await accept(candidateId)
  if(!withBrowser) assert.equal(accepted.status,'accepted')
  const saved=await skills()
  assert.equal(saved.skills.length,1)
  assert.equal(saved.skill_replays.length,1)
  const savedSkill=saved.skills[0]
  assert.equal(savedSkill.candidate_id,candidateId)
  assert.equal(savedSkill.replay_ticket_id,issued.replay_ticket_id)
  assert.equal(savedSkill.replay_artifact_id,proof.replay_artifact_id)
  assert.equal(saved.candidates.find(entry=>entry.id===candidateId)?.status,'accepted')
  const skillProof=JSON.parse(savedSkill.proof_json)
  assert.equal(skillProof.sha256,sourceSha)
  assert.equal(skillProof.standing_grant,false)
  assert.equal(skillProof.activation,false)
  assert.equal((await admin.get('/api/v1/memories')).memories.length,0)
  assert.equal((await grants()).grants.length,1)
  assert.equal(await countTickets(),2)
  await reject(accept(candidateId),(error)=>error.status===400)
  assert.equal((await replay(candidateId,{source_ticket_id:source.id})).replay_ticket_id,issued.replay_ticket_id)
  assert.equal(await countTickets(),2)
  assert.equal((await skills()).skills.length,1)
  record('explicit accept stores one proof-only Skill, no Memory, no new Grant, idempotent repeat',{skill_id:savedSkill.id,candidate_status:'accepted',duplicate_accept_rejected:withBrowser,skill_count:1,memory_count:0,grant_count:1,ticket_total:2,standing_permission:false})

  const mismatchedCandidate=await candidate('Second candidate catches changed deterministic bytes')
  const mismatchStart=await replay(mismatchedCandidate,{source_ticket_id:source.id})
  assert.equal(mismatchStart.status,'awaiting_execution')
  // This is an explicit test mutation, not any operation done by either read.
  const changed=Buffer.from(initialBytes.toString('utf8')+'Deliberately changed fixture for mismatch.\n')
  const {writeFile}=await import('node:fs/promises')
  await writeFile(join(projectRoot,'input.txt'),changed,{mode:0o600})
  assert.equal((await settle()).status,'succeeded')
  const mismatch=await replayState(mismatchedCandidate)
  assert.equal(mismatch.status,'sample_mismatch')
  assert.ok(mismatch.replay_artifact_id)
  const changedArtifact=await bytes(mismatchStart.replay_ticket_id,mismatch.replay_artifact_id)
  assert.notEqual(sha256(changedArtifact.content),sourceSha)
  assert.equal((await bytes(source.id,sourceArtifact.id)).artifact.sha256,sourceSha)
  await reject(accept(mismatchedCandidate),(error)=>error.status===400)
  assert.equal((await skills()).skills.length,1)
  record('changed actual bytes explicitly fail without judging the original or accepting a Skill',{status:mismatch.status,source_sha256:sourceSha,changed_sha256:sha256(changedArtifact.content),self_attested_skills:0})

  const revokedCandidate=await candidate('Revoked grant cannot start a further ordinary ticket')
  const beforeRevocation=await countTickets()
  await admin.post(`/api/v1/grants/${grantId}/revoke`,{})
  await reject(replay(revokedCandidate,{source_ticket_id:source.id}),(error)=>error.status===400 && /revoked|stale|scope|scope|missing|valid/i.test(error.message))
  assert.equal(await countTickets(),beforeRevocation)
  await assert.rejects(replayState(revokedCandidate),(error)=>error.status===400 && /not established/.test(error.message))
  const historical=await replayState(candidateId)
  assert.equal(historical.status,'verified')
  assert.equal(historical.authority_created,false)
  assert.ok(historical.grant_revocation_denied_at)
  assert.equal((await skills()).skills.length,1)
  assert.equal((await grants()).grants.length,1)
  assert.equal((await admin.get('/api/v1/memories')).memories.length,0)
  record('original Grant revocation prevents new replay while historical proof remains truthful',{ticket_total:beforeRevocation,grant_revocation_denied:true,source_sha256:sourceSha,replay_sha256:freshSha,historical_verified_only:true})

  const stateDir=server.dataDir
  await server.stop()
  server=await startRustConcierge({root:dirname(stateDir)})
  admin=new LoomHttpClient({baseUrl:server.baseUrl,clientToken:server.clientToken,timeoutMs:15000})
  const recovered=await replayState(candidateId)
  assert.equal(recovered.status,'verified')
  assert.equal(recovered.replay_ticket_id,issued.replay_ticket_id)
  assert.equal(sha256((await bytes(source.id,sourceArtifact.id)).content),sourceSha)
  assert.equal(sha256((await bytes(issued.replay_ticket_id,recovered.replay_artifact_id)).content),sourceSha)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid,true)
  const doctor=await promisify(execFile)('cargo',['run','-q','-p','loom-concierge','--bin','loom','--','--data-dir',server.dataDir,'doctor'],{env:{...process.env,LOOM_CLIENT_TOKEN:server.clientToken},timeout:120000,encoding:'utf8'})
  const persistence=JSON.parse(doctor.stdout)
  assert.equal(persistence.schema_version,7)
  assert.equal(persistence.integrity[0].integrity_check,'ok')
  assert.equal(persistence.audit_valid,true)
  record('controller reopen keeps both exact byte proofs, original lineage, independently accepted Skill and schema v7',{schema_version:persistence.schema_version,integrity:persistence.integrity[0].integrity_check,audit_valid:persistence.audit_valid,source_sha256:sourceSha,replay_sha256:freshSha,ordinary_replays:1,new_grants:0})

  console.log(JSON.stringify({overall:'PASS',schema:7,source_sha256:sourceSha,replay_sha256:freshSha,tickets:await countTickets(),checks,not_implemented:['general learned Skills','arbitrary commands','live LLM','general Grant or activation','provider/distribution','HTTP connectors'],foreground_workers_stopped:true},null,2))
} catch (error) {
  console.error(JSON.stringify({overall:'FAIL',error:error.stack,checks},null,2));process.exitCode=1
} finally {
  if(server) await server.stop()
}
