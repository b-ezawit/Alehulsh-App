import type {InboxRepository,AcceptanceRepository} from '../repositories/types.js';
export async function inboxState(inbox:Pick<InboxRepository,'listForRecipient'>,
  acceptances:Partial<Pick<AcceptanceRepository,'findFor'>>|undefined,uid:string,limit:number){
  const first=await inbox.listForRecipient(uid,limit);
  if(!acceptances?.findFor)return first.map(p=>({...p,hasAcknowledged:null}));
  const states=await Promise.all(first.map(async p=>{
    const response=await acceptances.findFor!(p.alertId,uid);
    return [p.alertKey??p.alertId,response!==null&&(response.alertKey??response.alertId)===(p.alertKey??p.alertId)] as const;
  }));
  const byKey=new Map(states);
  // Recheck live source/incident identity after asynchronous response reads.
  return (await inbox.listForRecipient(uid,limit)).map(p=>({...p,hasAcknowledged:byKey.get(p.alertKey??p.alertId)??false}));
}
