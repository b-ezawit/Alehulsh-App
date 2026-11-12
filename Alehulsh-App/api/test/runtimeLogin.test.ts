import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRestrictedRuntimeLogin } from '../src/db/runtimeLogin.js';
import type { Queryable } from '../src/db/pool.js';
const safe = { login: true, superuser: false, bypass: false, create_role: false, create_database: false, replication: false, other_roles: false };
function database(row: unknown) { return { query: async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }) } as unknown as Queryable; }
test('a dedicated unprivileged login is accepted', async () => { await requireRestrictedRuntimeLogin(database(safe)); });
for (const flag of ['superuser', 'bypass', 'create_role', 'create_database', 'replication', 'other_roles'] as const) {
  test(`runtime refuses the privileged connecting identity even after SET LOCAL ROLE: ${flag}`, async () => {
    await assert.rejects(requireRestrictedRuntimeLogin(database({ ...safe, [flag]: true })), /restricted runtime/);
  });
}
test('missing or non-login session identity is refused', async () => {
  await assert.rejects(requireRestrictedRuntimeLogin(database(null)));
  await assert.rejects(requireRestrictedRuntimeLogin(database({ ...safe, login: false })));
});
