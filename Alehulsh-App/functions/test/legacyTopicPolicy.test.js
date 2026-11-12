const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { legacyTopicHandler } = require("../legacyTopicPolicy");

function fixture(mode) {
  const sends = [], state = { expiries: 0, invalidModes: 0 }, exports = {};
  const env = mode === undefined ? {} : { ALEHULSH_DATA_ACCESS: mode };
  const firestore = () => ({});
  firestore.FieldValue = { serverTimestamp: () => null };
  firestore.Timestamp = { fromDate: (date) => date };
  const dependencies = {
    "firebase-functions/v2/firestore": {
      onDocumentCreated: (_, handler) => handler,
      onDocumentUpdated: (_, handler) => handler,
      onDocumentDeleted: (_, handler) => handler,
    },
    "firebase-functions/v2/scheduler": { onSchedule: (_, handler) => handler },
    "firebase-functions": { logger: { info() {}, warn() {}, error() {} } },
    "firebase-admin": { initializeApp() {}, firestore, messaging: () => ({ send: async (message) => { sends.push(message); return "synthetic-provider-id"; } }) },
    "./expiryReconciliation": { reconcileExpiredAlerts: async () => { state.expiries++; return 0; } },
    "./legacyTopicPolicy": { legacyTopicHandler: (handler) => legacyTopicHandler(handler, () => env, () => { state.invalidModes++; }) },
  };
  vm.runInNewContext(readFileSync(join(__dirname, "../index.js"), "utf8"), {
    exports, require: (name) => { assert.ok(dependencies[name]); return dependencies[name]; },
  });
  return { sends, state, exports };
}
async function triggerBroadcasts(f) {
  await f.exports.onAlertCreated({ params: { alertId: "synthetic-incident" }, data: { data: () => ({ status: "active", geohash: "synthetic" }) } });
  await f.exports.onAlertClosed({ params: { alertId: "synthetic-incident" }, data: { before: { data: () => ({ status: "active" }) }, after: { data: () => ({ status: "resolved" }) } } });
  await f.exports.onAlertDeleted({ params: { alertId: "synthetic-incident" } });
}
test("API-only mode disables all three legacy public notification paths", async () => {
  const f = fixture("trusted_api"); await triggerBroadcasts(f); assert.equal(f.sends.length, 0);
});
test("existing unconfigured beta behavior remains available until coordinated cutover", async () => {
  const f = fixture(); await triggerBroadcasts(f); assert.equal(f.sends.length, 3);
  assert.equal(f.sends[0].data.alertId, "synthetic-incident");
});
test("explicit Firestore compatibility mode preserves existing creation and terminal hints", async () => {
  const f = fixture("firestore"); await triggerBroadcasts(f); assert.equal(f.sends.length, 3);
});
test("malformed delivery modes cannot silently restore public broadcasts", async () => {
  for (const mode of ["", "production", "trusted-api", "true"]) { const f = fixture(mode); await triggerBroadcasts(f); assert.equal(f.sends.length, 0); assert.equal(f.state.invalidModes, 3); }
});
test("expiry reconciliation remains active independently of public-topic retirement", async () => {
  for (const mode of [undefined, "firestore", "trusted_api"]) { const f = fixture(mode); await f.exports.cleanupExpiredAlerts({}); assert.equal(f.state.expiries, 1); }
});
