# Environment files

Run `npm run env:init` from `api/` to create missing local files. Existing values
and comments are preserved; missing backend entries are appended with empty
values or the explicit safe default shown in the example. No secret is generated
or read from the shell environment. All actual environment files are ignored
and restricted to mode `0600`. Example files contain no credentials.

| File | Consumer | Contents |
| --- | --- | --- |
| `config/mobile.dev.json` | Flutter `--dart-define-from-file`, flavor `dev` | Public development origins and publishable Auth key only |
| `config/mobile.prod.json` | Flutter `--dart-define-from-file`, flavor `prod` | Public production origins and publishable Auth key only |
| `api/.dev.vars` | Local development / existing read-only operator preflight | Existing development credentials plus explicit runtime configuration |
| `api/.dev.vars.production` | Production-target local configuration staging | Backend runtime fields only; never mobile build inputs |

`api/.dev.vars.production` is **not** automatically deployed or uploaded. The
root `api/wrangler.local.jsonc` reads `.dev.vars` for local development and
`.dev.vars.production` when its named `production` local environment is selected.
Both configurations declare a runtime-only secret allowlist and have no remote
bindings, Cron schedule or public Workers URL. The older nested review config
is retained for existing tests. Do not bulk-upload `.dev.vars`:
its operator credentials must never become the Worker request identity. The
runtime allowlist in `api/scripts/environment-config.mjs` excludes those keys.

After configuration checks pass, `npm run worker:local` or
`npm run worker:local:prod` starts only the selected local Worker. These are not
deployment commands. Without approved database/storage bindings, protected
routes deliberately remain unavailable. Do not use this local manifest to
deploy or infer the contents of the existing hosted Worker.

Use secure local editing or secret management for missing backend values. Do
not paste secrets into chat, place them in Flutter JSON, or pass them on the
command line. FCM uses `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`.
The private key previously pasted into chat is exposed and is not installed by
this setup. Replacement/revocation requires an operator action. Push delivery
stays disabled; filling a credential slot does not approve activation or consent.

Run these **offline** checks from `api/`:

```sh
npm run env:check:dev
npm run env:check:prod
```

`npm run inspect:hosted` performs read-only Cloudflare ownership inspection using
the existing operator token, enumerating accessible accounts instead of treating
an empty default account as evidence that a production Worker is missing. It
matches the exact Workers subdomain, checks the production account/Worker pins
in `.dev.vars.production`, and reports route, deployment and binding metadata.
It never deploys, changes resources, returns provider secrets or prints binding
values. Ownership verification does not establish target-backend compatibility.
The optional public `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_WORKER_NAME` pins are
excluded from request bindings, like the operator token. Never copy the latter
into the production runtime file. Development and production R2 bucket names
may belong to different accounts; do not cross-wire their endpoints or bindings.

The read-only development preflight distinguishes DNS failures, client TLS
verification failures, pooler tenant routing and provider errors received after
verified TLS. A valid AAAA-only database host is different from NXDOMAIN. Auth
DNS failure must not be diagnosed as invalid JWT signing keys. Provider error
messages and connection credentials are not printed by these classifiers.

Missing settings produce exit code 1 and configuration names only. A successful
check establishes file/configuration consistency, never hosted connectivity,
resource permissions, consent approval, real notification delivery, or production
readiness. Production completeness is blocked while emergency delivery is off.
The initializer never changes an existing activation setting.

After the matching check passes and integration gates have been reviewed,
Flutter consumes the selected public file directly:

```sh
flutter run --flavor dev --dart-define-from-file=config/mobile.dev.json
flutter build appbundle --release --flavor prod --dart-define-from-file=config/mobile.prod.json
```

These are operator commands, not actions performed by environment setup. Dev
also requires its own Firebase options and Android app configuration. Release
packaging requires the real ignored `android/key.properties` and signing key;
there is no debug-signing fallback. No production URL is invented. A supplied
origin in a local file is a candidate until its TLS, route/authentication and
data isolation contracts have passed approved integration tests.

`JWT_SECRET`, `ALLOW_INSECURE_TOKENS`, `FIREBASE_SERVICE_ACCOUNT_JSON` and
`RESEND_API_KEY` are not target runtime inputs. Supabase authentication remains
authoritative; environment setup does not add custom token signing or a new
email/SMS delivery channel. App versioning remains in `pubspec.yaml`.

Hyperdrive and `EVIDENCE_BUCKET` are actual Cloudflare bindings. No environment
file can provision them. Restricted runtime identity, verified origin TLS,
disabled Hyperdrive query caching, hosted migrations, private R2 access,
existing-user/legacy cutover, consent/retention policy and physical Android
validation remain separate gates. See [development integration](../docs/development-integration.md).
