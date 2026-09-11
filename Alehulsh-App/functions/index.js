/**
 * Alehulsh (አለሁልሽ) - Enterprise Cloud Functions
 * High-Scale Server-Side 500m Radar Alert Dispatcher & Automatic 2-Hour TTL Cleaner
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
exports.cleanupExpiredAlerts = onSchedule("every 15 minutes", async (event) => {
  const now = new Date();
  logger.info(`Running 2-Hour TTL Safety Net Cleaner at ${now.toISOString()}...`);

  try {
    const expiredQuery = await db.collection("active_alerts")
      .where("expiresAtTimestamp", "<=", now)
      .limit(200)
      .get();

    if (expiredQuery.empty) {
      logger.info("No expired alerts found.");
      return;
    }

    const batch = db.batch();
    let count = 0;

    expiredQuery.forEach((doc) => {
      logger.info(`Auto-expiring orphaned SOS alert ${doc.id} (Created at: ${doc.get("timestamp")})`);
      batch.delete(doc.ref);
      count++;
    });

    await batch.commit();
    logger.info(`✅ Successfully purged ${count} expired alerts from active_alerts.`);
  } catch (error) {
    logger.error("❌ Error in cleanupExpiredAlerts:", error);
  }
});

/**
 * 3. SILENT DISMISSAL ON SOS RESOLUTION
 * When an SOS is cancelled or marked safe, sends a silent broadcast to clear heads-up notifications.
 */
exports.onAlertDeleted = onDocumentDeleted("active_alerts/{alertId}", async (event) => {
  const alertId = event.params.alertId;
  logger.info(`Alert ${alertId} was cancelled/deleted. Dismissing notification instances.`);

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
    logger.info(`✅ Sent dismissal for alert ${alertId}`);
  } catch (err) {
    logger.warn(`Dismissal send note: ${err.message}`);
  }
});
