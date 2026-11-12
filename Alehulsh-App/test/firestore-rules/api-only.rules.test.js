const { test, before, after } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } = require("firebase/firestore");
let env, owner, stranger, anonymous;
before(async () => {
  const endpoint = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw Error("isolated loopback emulator required");
  env = await initializeTestEnvironment({ projectId: "alehulsh-api-only-rules-test", firestore: {
    host: "127.0.0.1", port: Number(endpoint.split(":")[1]),
    rules: readFileSync(join(__dirname, "../../firestore.rules.api-only"), "utf8"),
  } });
  owner = env.authenticatedContext("synthetic-owner").firestore();
  stranger = env.authenticatedContext("synthetic-stranger").firestore();
  anonymous = env.unauthenticatedContext().firestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users/synthetic-owner"), { catName: "synthetic-legacy-secret", safetyKeywordHash: "synthetic-server-hash" });
    await setDoc(doc(db, "active_alerts/synthetic-owner"), { userId: "synthetic-owner", status: "active", alertKey: "synthetic-immutable-key" });
    await setDoc(doc(db, "inbox/synthetic-owner/alerts/synthetic-incident"), { alertId: "synthetic-incident" });
  });
});
after(async () => { await env?.cleanup(); });
test("target owner cannot create an alert through the SDK", () => assertFails(setDoc(doc(owner, "active_alerts/synthetic-new"), { userId: "synthetic-owner" })));
test("target owner cannot bypass keyword verification by resolving or escalating a slot", () => assertFails(updateDoc(doc(owner, "active_alerts/synthetic-owner"), { status: "resolved" })));
test("target owner cannot destroy an alert or its evidence metadata", () => assertFails(deleteDoc(doc(owner, "active_alerts/synthetic-owner"))));
test("target owner cannot reuse the legacy incident slot", () => assertFails(setDoc(doc(owner, "active_alerts/synthetic-owner"), { userId: "synthetic-owner", status: "active", alertKey: "replacement" })));
test("target owner cannot read the legacy plaintext keyword directly", () => assertFails(getDoc(doc(owner, "users/synthetic-owner"))));
test("target owner cannot replace the server keyword hash", () => assertFails(updateDoc(doc(owner, "users/synthetic-owner"), { safetyKeywordHash: "attacker-hash", mustSetKeyword: true })));
test("target owner cannot recreate a profile with a plaintext keyword", () => assertFails(setDoc(doc(owner, "users/synthetic-new"), { catName: "replacement" })));
test("target owner cannot mutate contacts outside the API", () => assertFails(setDoc(doc(owner, "users/synthetic-owner/contacts/synthetic-contact"), { phone: "synthetic-number" })));
test("target recipient cannot retrieve a stale inbox projection through the SDK", () => assertFails(getDoc(doc(owner, "inbox/synthetic-owner/alerts/synthetic-incident"))));
test("other users and anonymous clients cannot read owner data", async () => { for (const db of [stranger, anonymous]) await assertFails(getDoc(doc(db, "users/synthetic-owner"))); });
test("target clients cannot enumerate legacy incident records", () => assertFails(getDocs(collection(owner, "active_alerts"))));
test("trusted server fixtures retain access while SDK clients are closed", () => env.withSecurityRulesDisabled(context => assertSucceeds(getDoc(doc(context.firestore(), "users/synthetic-owner")))));
