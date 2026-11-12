import type { Queryable } from './pool.js';
/** SET LOCAL ROLE does not revoke a privileged session_user's ability to RESET
 * ROLE. Workers must connect as a dedicated login with only API membership. */
export async function requireRestrictedRuntimeLogin(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ login: boolean; superuser: boolean; bypass: boolean; create_role: boolean; create_database: boolean; replication: boolean; other_roles: boolean; }>(`
  SELECT r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolbypassrls AS bypass,
   r.rolcreaterole AS create_role,r.rolcreatedb AS create_database,r.rolreplication AS replication,
   EXISTS(SELECT 1 FROM pg_roles membership
      WHERE membership.rolname NOT IN (session_user,'alehulsh_api')
        AND pg_has_role(session_user,membership.oid,'MEMBER')) AS other_roles
  FROM pg_roles r WHERE r.rolname=session_user`);
  const role = rows[0];
  if (!role || !role.login || role.superuser || role.bypass || role.create_role || role.create_database || role.replication || role.other_roles) {
    throw Error('dedicated restricted runtime database login required');
  }
}
