/**
 * Alehulsh (አለሁልሽ) - Enterprise Cloud Functions
 * Server-side radar alert dispatcher and expiry reconciliation.
 */

const { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * 1. SERVER-SIDE 500m RADAR ALERT BROADCASTER
 * Triggered instantly when a victim's phone writes ONE single document to active_alerts/{alertId}.
 * The victim's phone does NOT need to loop over hundreds of contacts or nearby users.
 * Firebase edge servers blast out high-priority push notifications in milliseconds.
 */
exports.onAlertCreated = onDocumentCreated("active_alerts/{alertId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    logger.warn("No data associated with the event");
    return;
  }

  const alertData = snapshot.data();
  const alertId = event.params.alertId;

  if (alertData.status !== "active") {
    logger.info(`Alert ${alertId} is not active. Skipping broadcast.`);
    return;
  }

  const geohash = alertData.geohash || (alertData.geo ? alertData.geo.geohash : "");

  // Use 5-character Geohash prefix (~2.4km radius surrounding the 500m zone)
  const geohash5 = geohash ? geohash.substring(0, 5) : "";
  const topicName = geohash5 ? `sos_radar_${geohash5}` : "sos_radar_global";

  logger.info(`Dispatching SOS broadcast for ${alertId} to topic: ${topicName}`);

  // P0-09 — NO PERSONAL DATA IN THE PAYLOAD.
  //
  // This previously carried userName, locationName and exact latitude/longitude.
  // FCM topic subscription is a client-side operation with no server-side
  // authorization, so any device could subscribe to every sos_radar_* cell over
  // Addis Ababa and passively receive the name and precise coordinates of every
  // SOS raised in the city. (CRIT-03)
  //
  // The payload now carries only an opaque alert id. Recipients fetch detail
  // over an authorized read — which, during containment, they cannot do, so
  // responder notifications are non-functional until the fan-out in P2-04/P2-05
  // replaces topics with server-selected device tokens.
  const message = {
    topic: topicName,
    data: {
      alertId: String(alertId),
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    },
    notification: {
      title: "Alehulsh",
      body: "Open Alehulsh to see if you can help nearby.",
    },
    android: {
      priority: "high",
      notification: {
        channelId: "alehulsh_emergency_alerts_v2",
        priority: "max",
        defaultSound: true,
        defaultVibrateTimings: true,
        // P1-05 will take this further: lock-screen visibility must not reveal
        // that an emergency is in progress at all.
        visibility: "private",
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    logger.info(`Broadcast SOS ${alertId} to topic ${topicName}: ${response}`);
  } catch (error) {
    logger.error(`Error broadcasting SOS to topic ${topicName}:`, error);
  }
});

/**
 * 2. AUTOMATIC 2-HOUR TTL SAFETY NET CLEANER
 * Runs automatically every 15 minutes.
 * Deletes any orphaned active alerts that have exceeded the 2-hour safety window.
 */
/**
 * 2. EXPIRY RECONCILIATION  (P3-14)
 *
 * THIS USED TO DELETE. It ran `batch.delete(doc.ref)` on every alert whose
 * expiresAtTimestamp had passed, regardless of status — so an escalated alert,
 * an alert carrying a cluster of failed keyword attempts, or a resolved one
 * that a survivor might need for a protection order were all destroyed two
 * hours after the SOS was raised.
 *
 * That is the same failure as CRIT-05, where cancelling deleted the alert and
 * all its evidence, only on a timer instead of a button. alert-lifecycle.md is
 * explicit: deletion stops being how an alert ends. An alert that runs out of
 * time becomes `expired`; it does not cease to have existed.
 *
 * The native TTL policy on expiresAtTimestamp was removed from
 * firestore.indexes.json for the same reason. Handing this job to Firestore
 * would have made the deletion faster and unthrottled — the opposite of what
 * was wanted.
 *
 * There is also no backlog to drain. active_alerts is keyed by the owner's
 * uid, so it holds at most one document per user and cannot grow unbounded.
 * The old 200-per-run limit was never the constraint it looked like.
 *
 * Reaching this function at all is a bug signal. Expiry is the backstop:
 * alert-lifecycle.md §2 treats an alert that expires while still active as
 * evidence that escalation did not run. It is logged at error for that reason.
 */
exports.cleanupExpiredAlerts = onSchedule("every 15 minutes", async (event) => {
  const now = new Date();

  try {
    const expired = await db.collection("active_alerts")
      .where("expiresAtTimestamp", "<=", now)
      .limit(200)
      .get();

    if (expired.empty) {
      return;
    }

    const batch = db.batch();
    let transitioned = 0;

    expired.forEach((doc) => {
      const status = doc.get("status");

      // Already terminal. Left exactly as it is — this function's job is to
      // close alerts that ran out of time, not to tidy away history.
      if (status === "resolved" || status === "expired") {
        return;
      }

      logger.error("Alert expired while still open — escalation did not run", {
        alertId: doc.id,
        status,
        expiresAt: doc.get("expiresAtTimestamp"),
      });

      batch.update(doc.ref, {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transitioned++;
    });

    if (transitioned > 0) {
      await batch.commit();
      logger.warn(`Transitioned ${transitioned} alert(s) to expired.`);
    }
  } catch (error) {
    logger.error("Error in cleanupExpiredAlerts:", error);
  }
});

/**
 * 3. SILENT DISMISSAL WHEN AN ALERT CLOSES
 *
 * A responder's phone is showing a high-priority notification about an
 * emergency. When that emergency ends, the notification has to go — otherwise
 * people are walking toward an alert that is already over, and the next real
 * one is harder to take seriously.
 *
 * Two triggers, because an alert can close two ways:
 *
 *   onAlertClosed  — status transitions to resolved or expired. This is the
 *     path everything uses now: P1-09 resolves by transition, and P3-14 made
 *     expiry a transition too. It did not exist before, which means resolving
 *     through the API already left stale notifications on every responder's
 *     phone.
 *   onAlertDeleted — the legacy client path. alert_service.dart still deletes
 *     on cancel (CRIT-05); this stays until P1-08.5 cuts the client over, and
 *     should be removed with it.
 */
const TERMINAL = ["resolved", "expired"];

async function sendDismissal(alertId, reason) {
  const dismissMessage = {
    topic: "sos_dismissals",
    data: {
      action: "DISMISS_ALERT",
      alertId: String(alertId),
    },
    android: {
      priority: "high",
    },
  };

  try {
    await admin.messaging().send(dismissMessage);
    logger.info(`Sent dismissal for alert ${alertId} (${reason})`);
  } catch (err) {
    logger.warn(`Dismissal send note for ${alertId}: ${err.message}`);
  }
}

exports.onAlertClosed = onDocumentUpdated("active_alerts/{alertId}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) {
    return;
  }

  // Only on the transition itself. Any other update to a closed alert must not
  // re-send, or a dismissal becomes its own source of notification noise.
  const justClosed = !TERMINAL.includes(before.status) && TERMINAL.includes(after.status);
  if (!justClosed) {
    return;
  }

  await sendDismissal(event.params.alertId, `status ${before.status} -> ${after.status}`);
});

exports.onAlertDeleted = onDocumentDeleted("active_alerts/{alertId}", async (event) => {
  await sendDismissal(event.params.alertId, "document deleted");
});
