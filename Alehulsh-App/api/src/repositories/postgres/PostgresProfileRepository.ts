import type { Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
export interface OwnedProfile {
  fullName: string; homeAddress: string; phoneNumber: string | null;
  safetyKeywordSet: boolean; mustSetKeyword: boolean; phoneVerified: boolean; emailVerified: boolean;
  locationSharingEnabled: boolean | null; autoAudioRecording: boolean | null; fakeCallEnabled: boolean | null; communityAlertsEnabled: boolean | null;
}
export interface ProfileUpdate {
  fullName?: string; homeAddress?: string; phoneNumber?: string | null;
  locationSharingEnabled?: boolean; autoAudioRecording?: boolean; fakeCallEnabled?: boolean; communityAlertsEnabled?: boolean;
}
const fields = {
  fullName: 'display_name', homeAddress: 'home_address', phoneNumber: 'phone_e164',
  locationSharingEnabled: 'location_sharing_enabled', autoAudioRecording: 'auto_audio_recording', fakeCallEnabled: 'fake_call_enabled', communityAlertsEnabled: 'community_alerts_enabled'
} as const;
/** Authenticated/owner identity is additionally checked in every statement. */
export class PostgresProfileRepository {
  constructor(private readonly db: Queryable) { }
  async get(uid: string): Promise<OwnedProfile | null> {
    const { rows } = await this.db.query(`SELECT u.display_name,u.home_address,u.phone_e164,
    u.keyword_hash IS NOT NULL AS keyword_set,u.must_set_keyword,u.phone_verified_at IS NOT NULL AS phone_verified,
    u.email_verified_at IS NOT NULL AS email_verified,u.location_sharing_enabled,u.auto_audio_recording,u.fake_call_enabled,u.community_alerts_enabled
   FROM users u JOIN identity_map m ON m.user_id=u.id WHERE m.firebase_uid=$1 AND u.id=auth.uid()`, [uid]);
    const row = rows[0]; return row ? {
      fullName: row.display_name, homeAddress: row.home_address, phoneNumber: row.phone_e164,
      safetyKeywordSet: row.keyword_set, mustSetKeyword: row.must_set_keyword,
      phoneVerified: row.phone_verified, emailVerified: row.email_verified, locationSharingEnabled: row.location_sharing_enabled,
      autoAudioRecording: row.auto_audio_recording, fakeCallEnabled: row.fake_call_enabled, communityAlertsEnabled: row.community_alerts_enabled
    } : null;
  }
  async update(uid: string, input: ProfileUpdate): Promise<OwnedProfile> {
    const entries = Object.entries(input); if (!entries.length) throw new AppError('invalid_request');
    const values: unknown[] = [uid]; const assignments = entries.map(([key, value]) => { if (!Object.hasOwn(fields, key)) throw new AppError('invalid_request'); const column = fields[key as keyof ProfileUpdate]; if (!column) throw new AppError('invalid_request'); values.push(value); return `${column}=$${values.length}`; });
    if (Object.hasOwn(input, 'phoneNumber')) {
      const position = entries.findIndex(([name]) => name === 'phoneNumber') + 2;
      assignments.push(`phone_hash=CASE WHEN phone_e164 IS NOT DISTINCT FROM $${position} THEN phone_hash END`,
        `phone_verified_at=CASE WHEN phone_e164 IS NOT DISTINCT FROM $${position} THEN phone_verified_at END`);
    }
    const { rowCount } = await this.db.query(`UPDATE users SET ${assignments.join(',')}
   WHERE id=auth.uid() AND id=(SELECT user_id FROM identity_map WHERE firebase_uid=$1)`, values);
    if (rowCount !== 1) throw new AppError('not_found');
    const profile = await this.get(uid); if (!profile) throw new AppError('not_found'); return profile;
  }
}
