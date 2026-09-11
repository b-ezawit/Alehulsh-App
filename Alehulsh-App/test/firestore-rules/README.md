# Firestore rules tests

Regression suite for `Alehulsh-App/firestore.rules` (P1-25).

Every CRIT finding from the audit has a test that fails against the ruleset
that shipped. **Run this before any rules deploy.**

```bash
cd Alehulsh-App/test/firestore-rules
npm install
npm test
```

Runs against the local Firestore emulator under the throwaway project id
`alehulsh-rules-test`, so it cannot reach the real project. Requires Java 17+.

## What it covers

| Group | Guards against |
|---|---|
| unauthenticated | The ruleset actually deployed (`allow read, write: if true`) |
| signed-in stranger | CRIT-01, CRIT-02, CRIT-04 |
| owner | Regressions that would break the SOS path |
| queries | The global-read leak, and that the cleanup query still works |

Add a test here for any rule you change. A rule without a test is a rule nobody
has checked.
