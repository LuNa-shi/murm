import { createHash } from 'node:crypto';
import { createProgrammingContract } from './programming.js';
import { verifyScaleMASCollaboration } from '../scalemas/collaboration-evidence.js';
const fail=()=>{throw Object.assign(new Error('HOUR_SCALEMAS_ARTIFACT_INVALID'),{code:'HOUR_SCALEMAS_ARTIFACT_INVALID'});};
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Small auditable workload, not a claim about mathematical research quality.
 * Every publication contains an independently checked square. After publisher
 * shutdown, consumers must discover/visit its exact immutable last publication
 * and explicitly adopt its value and address in a later contribution. */
export function createScaleMASArithmeticWorkload({ programming } = {}) {
  const program = createProgrammingContract(programming);
  let publisherId,original,afterStop,beforeSuccessor,consumerId,publisherReceipt;
  const seen=new Set(), accepted=new Map();
  const producerTag = attempt => attempt ? `hourproducerfinalretry${attempt}` : 'hourproducerfinal';
  return {
    rounds:6,
    question:'For every cycle publish exactly one self-contained JSON content record with fields peer, phase, n, square. peer and phase are the numbers in the host input. n=17*(peer+1)+phase and square=n*n. Use swarm substrate publish with a JSON input containing content as the JSON string and references as an array. Include the words square, peer and phase in the content. Peer 0 publishes normally through cycle 5 and then stops; its cycle 5 JSON must also contain tag:"hourproducerfinal". Other peers, from cycle 4 onward, search for the unique hourproducerfinal token, visit that exact original, and add adoptedSquare and sum fields: adoptedSquare=the visited original square; sum=your square+adoptedSquare. Cite its actual substrate address in references. Never fabricate an address. Use the CLI to write and run the requested program, inspect its stdout, search and visit where required, and publish the complete JSON. Search requires an explicit limit from 1 to 8. All work is finite; preserve the original content. Use actual Bash CLI calls; read a schema only if needed to resolve a concrete missing field.',
    questionForCycle({peerIndex,round}) { return this.question + program.prompt(peerIndex, round) +
      (peerIndex !== 0 && round >= 4 && original ? `\nThe stopped publisher has a verified original at ${original.address}. For this cycle search its exact token ${JSON.parse(original.content).tag} with limit 8, visit that exact address and cite it. This verified token replaces the generic hourproducerfinal search token above.` : ''); },
    ready({peerIds}){publisherId=peerIds[0];consumerId=peerIds[1];},
    async beforeCycle({peerIndex,round,publisherStopped}){if(peerIndex!==0 && round===4)await publisherStopped;},
    publisherStopped({receipt,snapshot}){
      if(receipt.botId!==publisherId||receipt.execution!=='stopped')fail();
      publisherReceipt=structuredClone(receipt);afterStop=structuredClone(snapshot);
      original=snapshot.contents.find(row=>{try{const value=JSON.parse(row.content);return row.author===publisherId&&value.phase===5&&row.address===accepted.get(`${publisherId}:5`);}catch{return false;}});
      if(!original || !/^hourproducerfinal(?:retry[1-9][0-9]*)?$/.test(JSON.parse(original.content).tag))fail();
    },
    async cycle({peerIndex,botId,round,attempt=0,beforeSnapshot,snapshot}){
      const previous = new Set((beforeSnapshot?.contents ?? []).map(row => row.address));
      const matches=snapshot.contents.filter(row=>row.author===botId&&!previous.has(row.address));
      if(matches.length!==1)fail();const row=matches[0];
      let value;try{value=JSON.parse(row.content);}catch{fail();}
      const n=17*(peerIndex+1)+round;
      if(value.peer!==peerIndex||value.phase!==round)fail();
      if(value.n!==n||value.square!==n*n||seen.has(row.address))fail();
      if(peerIndex===0&&round===5&&value.tag!==producerTag(attempt))fail();
      if(peerIndex!==0&&round>=4&&(!original||value.adoptedSquare!==484||value.sum!==n*n+484||!row.references.includes(original.address)))fail();
      try { await program.verify(peerIndex, round, value); }
      catch(error) {
        if(error.code!=='HOUR_PROGRAMMING_INVALID'||error.rejected!==true)throw error;
        return {correction:`The independent checker rejected the programming result in your immutable publication ${row.address} for peer=${peerIndex} phase=${round}. Recheck the complete original task input and every case; inspect your actual program and stdout and fix the cause. No reference answer is supplied. Preserve the rejected publication and copy its source/stdout to distinct rejected-attempt filenames before editing; keep the final canonical program/stdout filenames for the corrected proof. Publish exactly one new corrected record for this same peer and phase using a fresh publication request ID; preserve all collaboration fields and actual citations. Retain corrected source and stdout for private collection.${peerIndex===0&&round===5 ? ` For this correction replace the producer tag with ${producerTag(attempt+1)}.` : ''}`,
          rejected:{reference:row.address,sha256:hash(row.content),code:'HOUR_PROGRAMMING_INVALID'}};
      }
      seen.add(row.address); accepted.set(`${botId}:${round}`,row.address);
      if(peerIndex!==0&&round>=4){
        if(botId===consumerId&&round===4)beforeSuccessor=structuredClone(snapshot);
      }
      let handoff;
      if(botId===consumerId&&round===5){
        const checked=verifyScaleMASCollaboration({publisherStop:publisherReceipt,afterStop,beforeSuccessor,finalSnapshot:snapshot,consumerId,originalAddress:original.address,successorAddress:row.address});
        // Resource cleanup is checked against actual Core owner receipts later;
        // this domain check uses only the confirmed publisher execution stop.
        handoff={kind:checked.scope,reference:row.address,sha256:hash(JSON.stringify(checked))};
      }
      return {proof:{reference:row.address,sha256:hash(row.content)},...(handoff?{handoff}:{})};
    },
  };
}
