import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../../errors.js';
import {normalizePhone} from '../../crypto/identifier.js';
import type { OwnedProfile, ProfileUpdate } from '../postgres/PostgresProfileRepository.js';
import type { OwnedContact, ContactWrite } from '../postgres/PostgresContactManagementRepository.js';

interface VerifiedProfile { phoneNumber?: string; emailVerified: boolean; disabled: boolean; }
/** Transitional storage adapter behind the same owned-account HTTP contract.
 * Identity and keyword fields never come from client profile payloads. */
export class FirestoreAccountRepository {
  constructor(private readonly db: Firestore, private readonly provider: { getUser(uid: string): Promise<VerifiedProfile> }) {}
  private ref(uid: string) {
    if(!uid || uid.length>128 || /[/\u0000]/.test(uid))throw new AppError('not_found');
    return this.db.collection('users').doc(uid);
  }
  async get(uid: string): Promise<OwnedProfile | null> {
    const [snapshot,identity]=await Promise.all([this.ref(uid).get(),this.provider.getUser(uid)]);
    if(!snapshot.exists||identity.disabled)return null;
    const d=snapshot.data()!;
    return { fullName: typeof d['fullName']==='string'?d['fullName']:'',homeAddress:typeof d['homeAddress']==='string'?d['homeAddress']:'',
      phoneNumber:typeof d['phoneNumber']==='string'?d['phoneNumber']:null,
      safetyKeywordSet:typeof d['safetyKeywordHash']==='string'&&!!d['safetyKeywordHash'],mustSetKeyword:d['mustSetKeyword']===true,
      phoneVerified:!!identity.phoneNumber&&identity.phoneNumber===d['phoneNumber'],emailVerified:identity.emailVerified===true,
      locationSharingEnabled:d['locationSharingConsentVersion']===1&&d['isLocationSharingEnabled']===true,
      autoAudioRecording:d['isAutoAudioRecording']===true,fakeCallEnabled:d['isFakeCallEnabled']===true,communityAlertsEnabled:d['isCommunityAlertsEnabled']===true };
  }
  async update(uid: string,input: ProfileUpdate): Promise<OwnedProfile> {
    const fields:Record<string,string>={fullName:'fullName',homeAddress:'homeAddress',phoneNumber:'phoneNumber',
      locationSharingEnabled:'isLocationSharingEnabled',autoAudioRecording:'isAutoAudioRecording',fakeCallEnabled:'isFakeCallEnabled',communityAlertsEnabled:'isCommunityAlertsEnabled'};
    const entries=Object.entries(input);if(!entries.length||entries.some(([key])=>!Object.hasOwn(fields,key)))throw new AppError('invalid_request');
    const patch:Record<string,unknown>={};for(const [key,value]of entries)patch[fields[key]!]=value;
    if(input.locationSharingEnabled!==undefined)patch['locationSharingConsentVersion']=input.locationSharingEnabled?1:0;
    await this.db.runTransaction(async tx=>{
      const ref=this.ref(uid),current=await tx.get(ref);if(!current.exists)throw new AppError('not_found');
      if(input.phoneNumber!==undefined&&input.phoneNumber!==current.get('phoneNumber')) {
        for(const key of ['phoneHash','phoneVerified','phoneVerifiedAt'])patch[key]=FieldValue.delete();
      }
      tx.update(ref,patch);
    });
    const profile=await this.get(uid);if(!profile)throw new AppError('not_found');return profile;
  }
  async list(uid: string): Promise<OwnedContact[]> {
    const snapshot=await this.ref(uid).get();const rows=snapshot.get('emergencyContacts');
    if(!Array.isArray(rows))return [];
    return rows.map((row,index)=>({id:typeof row.id==='string'?row.id:`legacy-${index}`,name:row.name??'',phone:row.phone??'',
      email:row.email??'',relationship:row.relationship??'',isPrimary:row.isPrimary===true}));
  }
  async put(uid: string,id: string,contact: ContactWrite): Promise<boolean> {
    return this.db.runTransaction(async tx=>{
      const ref=this.ref(uid),snapshot=await tx.get(ref);if(!snapshot.exists)throw new AppError('not_found');
      const raw=snapshot.get('emergencyContacts'),rows:OwnedContact[]=Array.isArray(raw)?raw:[];
      const index=rows.findIndex(c=>c.id===id),created=index<0;
      if(created&&rows.length>=6)throw new AppError('rate_limited');
      if(rows.some(c=>c.id!==id&&typeof c.phone==='string'&&normalizePhone(c.phone)===contact.phone))throw new AppError('conflict');
      const updated=rows.map(c=>contact.isPrimary?{...c,isPrimary:false}:c);
      if(created)updated.push({id,...contact});else updated[index]={id,...contact};
      tx.update(ref,{emergencyContacts:updated});return created;
    });
  }
  async remove(uid: string,id: string): Promise<void> {
    await this.db.runTransaction(async tx=>{
      const ref=this.ref(uid),snapshot=await tx.get(ref);if(!snapshot.exists)return;
      const rows=snapshot.get('emergencyContacts');if(Array.isArray(rows))tx.update(ref,{emergencyContacts:rows.filter(row=>row.id!==id)});
    });
  }
}
