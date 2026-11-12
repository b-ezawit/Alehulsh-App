import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function migrationInventory(directory) {
  return readdirSync(directory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => {
    const sql = readFileSync(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}
export function verifyMigrationLedger(inventory, applied) {
  const files = new Map(inventory.map(item => [item.name, item.checksum]));
  for (const row of applied) {
    if (!row.checksum) throw Error('Migration ledger lacks verified checksums; operator review required');
    if (!files.has(row.filename) || files.get(row.filename) !== row.checksum) {
      throw Error('Migration inventory differs from the applied ledger; operator review required');
    }
  }
}
