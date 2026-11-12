// The default preserves existing beta clients until the coordinated cutover.
// Explicit target mode and malformed modes fail closed for public broadcasts.
function legacyTopicHandler(handler, environment = () => process.env,
  reportInvalid = () => console.error("Legacy notification mode is invalid; public delivery is disabled.")) {
  return async (...args) => {
    const mode = environment().ALEHULSH_DATA_ACCESS;
    if (mode !== undefined && mode !== "firestore") {
      if (mode !== "trusted_api") reportInvalid();
      return;
    }
    return handler(...args);
  };
}
module.exports = { legacyTopicHandler };
