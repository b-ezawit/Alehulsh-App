/**
 * One-off: hash the plaintext safety keywords and remove them.  (P1-11)
 *
 *   npx tsc && node dist/scripts/migrate-keywords.js            # dry run
 *   npx tsc && node dist/scripts/migrate-keywords.js --apply    # writes
 *
 * DRY RUN BY DEFAULT. This deletes a field from every user document; it is not
 * something to trigger by pressing up-arrow in a shell.
 *
 * Run it against a copy of production first. There is no undo — the plaintext
 * is the only copy, and that is the entire point of the task.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { hashKeyword, isShippedDefault } from '../src/crypto/keyword.js';

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 200;

function env(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

async function main(): Promise<void> {
  const projectId = env('FIREBASE_PROJECT_ID');
  const pepper = env('KEYWORD_PEPPER');

  const app = initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore(app);

  const stats = { scanned: 0, hashed: 0, flaggedDefault: 0, alreadyDone: 0, noKeyword: 0 };

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} against project ${projectId}\n`);

  const snap = await db.collection('users').get();
  let batch = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    stats.scanned++;
    const data = doc.data();
    const plaintext = typeof data['catName'] === 'string' ? data['catName'] : '';

    if (data['safetyKeywordHash']) { stats.alreadyDone++; continue; }
    if (!plaintext.trim()) {
      // No keyword at all. Under the old code ANY non-empty answer cancelled
      // her alert (alert_service.dart:301), so she is in the same position as
      // a default-keyword user: force a reset.
      stats.noKeyword++;
      if (APPLY) {
        batch.update(doc.ref, { mustSetKeyword: true, catName: FieldValue.delete() });
        pending++;
      }
      continue;
    }

    if (isShippedDefault(plaintext)) {
      // Hashing 'Milo' would preserve the illusion of a secret that every
      // other user also has. Flag instead — P1-12/P1-13 force a real one.
      stats.flaggedDefault++;
      if (APPLY) {
        batch.update(doc.ref, { mustSetKeyword: true, catName: FieldValue.delete() });
        pending++;
      }
      continue;
    }

    stats.hashed++;
    if (APPLY) {
      const hash = await hashKeyword(plaintext, pepper);
      batch.update(doc.ref, {
        safetyKeywordHash: hash,
        mustSetKeyword: false,
        catName: FieldValue.delete(),
      });
      pending++;
    }

    if (pending >= BATCH_SIZE) { await batch.commit(); batch = db.batch(); pending = 0; }
  }

  if (APPLY && pending > 0) await batch.commit();

  // Never log a keyword, a uid or a hash. Counts only.
  console.log('  scanned          ', stats.scanned);
  console.log('  hashed           ', stats.hashed);
  console.log('  flagged: default ', stats.flaggedDefault, '(must set a real keyword)');
  console.log('  flagged: none set', stats.noKeyword, '(must set a real keyword)');
  console.log('  already migrated ', stats.alreadyDone);
  if (!APPLY) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().catch((err: unknown) => {
  process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
