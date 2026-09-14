# Closing direct client writes (P1-27)

**Status:** ruleset written and tested, **not deployed**. `firestore.rules.closed`.

---

## 1. What this ends

Every critical finding in the audit was a **write** permission on
`active_alerts`:

| Finding | What the write allowed |
|---|---|
| CRIT-04 | any account overwriting `voiceNotes` and `responders` on any alert — remote evidence destruction |
| CRIT-05 | the owner's own client deciding alert state, so cancelling hard-deleted the alert and all its evidence |
| P3-13 | the device clock setting `expiresAtTimestamp` |

None of these is fixable with a better rule. Firestore cannot verify a keyword,
cannot preserve evidence, cannot stamp its own clock, and cannot express "only
if you are near this alert". Removing client writes is the fix.

## 2. Why it is not deployed

Deploying it today breaks every installed build, because the client still
writes directly — 23 call sites across 9 files, and **zero** API calls.

## 3. Preconditions, in order

1. **P1-08.5** — the client calls the API instead of writing. Beza. Not
   started as of this writing.
2. **P1-26.2** — the force-upgrade screen ships, so old builds can be shut out
   rather than waited out. Beza. The server half (P1-26.1, P1-26.3) is done.
3. **Adoption measured** — `GET /internal/version-distribution` shows what
   fraction of accounts are on the callable-only build. This is a **decision
   gated on a number, not on a date**. Anyone still below the floor loses the
   ability to raise an alert the moment this deploys.
4. **The API is actually deployable** — it is not. `M-07` has no durable task
   queue, and the process refuses to start in production without one.

## 4. What it does not close

`users` stays client-writable. Closing it needs endpoints for the profile
fields the app edits, and `P2-02` has not decided which of those fields survive.
Building them before that decision would mean building them twice.

The keyword is already out: `P1-11` moved it behind `PUT /v1/me/keyword`, so
the most sensitive field in the profile is no longer set from a client.

## 5. Rollback

Keep the previous ruleset. Redeploying it is one command and takes effect in
seconds:

```bash
firebase deploy --only firestore:rules
```

The failure mode to watch for is not an error — it is silence. A client whose
write is denied may swallow the failure (`emergency_screen.dart` does exactly
that today), so **an SOS that does not arrive looks identical to no SOS**. Watch
alert creation volume, not error rates, for the first hour after deploying.
