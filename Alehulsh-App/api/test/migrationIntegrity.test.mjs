import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationInventory, verifyMigrationLedger } from '../db/migrationIntegrity.mjs';

test('inventory hashes exact migration contents and detects edited or missing applied files', () => {
  const directory=mkdtempSync(join(tmpdir(),'alehulsh-migrations-'));
  try {
    writeFileSync(join(directory,'0001_example.sql'),'SELECT 1;\n');
    const inventory=migrationInventory(directory), row={filename:inventory[0].name,checksum:inventory[0].checksum};
    assert.doesNotThrow(()=>verifyMigrationLedger(inventory,[row]));
    writeFileSync(join(directory,'0001_example.sql'),'SELECT 2;\n');
    assert.throws(()=>verifyMigrationLedger(migrationInventory(directory),[row]),/operator review/);
    assert.throws(()=>verifyMigrationLedger([],[row]),/operator review/);
  } finally { rmSync(directory,{recursive:true}); }
});
test('legacy ledger entries without checksum cannot be silently blessed', () => {
  assert.throws(()=>verifyMigrationLedger([{name:'0001_example.sql',checksum:'a'}],[{filename:'0001_example.sql'}]),/operator review/);
});
