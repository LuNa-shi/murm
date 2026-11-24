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
  const seen=new Set();
  return {
    rounds:6,
    question:'For every cycle publish exactly one self-contained JSON content record with fields peer, phase, n, square. peer and phase are the numbers in the host input. n=17*(peer+1)+phase and square=n*n. Use swarm substrate publish with a JSON input containing content as the JSON string and references as an array. Include the words square, peer and phase in the content. Peer 0 publishes normally through cycle 5 and then stops; its cycle 5 JSON must also contain tag:"hourproducerfinal". Other peers, from cycle 4 onward, search for the unique hourproducerfinal token, visit that exact original, and add adoptedSquare and sum fields: adoptedSquare=the visited original square; sum=your square+adoptedSquare. Cite its actual substrate address in references. Never fabricate an address. Use one coherent Bash call for the entire turn: write and run the requested program, parse its stdout locally, search/visit where required, independently check arithmetic, and publish the same complete JSON. Do not split this into exploratory model turns. Search requires an explicit limit from 1 to 8. All work is finite; preserve the original content. Use actual Bash CLI calls; read a schema only if needed to resolve a concrete missing field.',
    questionForCycle({peerIndex,round}) { return this.question + program.prompt(peerIndex, round); },
    ready({peerIds}){publisherId=peerIds[0];consumerId=peerIds[1];},
    async beforeCycle({peerIndex,round,publisherStopped}){if(peerIndex!==0 && round===4)await publisherStopped;},
    publisherStopped({receipt,snapshot}){
      if(receipt.botId!==publisherId||receipt.execution!=='stopped')fail();
      publisherReceipt=structuredClone(receipt);afterStop=structuredClone(snapshot);
      original=snapshot.contents.find(row=>{try{const value=JSON.parse(row.content);return row.author===publisherId&&value.phase===5;}catch{return false;}});
      if(!original || JSON.parse(original.content).tag !== 'hourproducerfinal')fail();
    },
    async cycle({peerIndex,botId,round,snapshot}){
      const matches=snapshot.contents.filter(row=>{try{const value=JSON.parse(row.content);return row.author===botId&&value.phase===round&&value.peer===peerIndex;}catch{return false;}});
      if(matches.length!==1)fail();const row=matches[0],value=JSON.parse(row.content),n=17*(peerIndex+1)+round;
      if(value.n!==n||value.square!==n*n||seen.has(row.address))fail();
      await program.verify(peerIndex, round, value);seen.add(row.address);
      if(peerIndex!==0&&round>=4){
        if(!original||value.adoptedSquare!==484||value.sum!==n*n+484||!row.references.includes(original.address))fail();
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
