// Preloaded by `npm test`, and imported by the tests that start runs so that one
// of them run alone is covered too. Run-status publication is on unless it is
// turned off, so the suite turns it off: a test publishes where it says to,
// never in the developer's own directory.
process.env.MACHINES_RUN_STATUS_DIR = "off";
delete process.env.MACHINES_RUN_OWNER;
delete process.env.MACHINES_RUN_PARENT;
delete process.env.MACHINES_RUN_LABEL;
// A developer's usage-limit settings must not change which preset a test run uses or how long it waits.
delete process.env.MACHINES_AGENT_FALLBACK;
delete process.env.MACHINES_AGENT_LIMIT_WAIT_MINUTES;
// A developer's saved provider order must not change deterministic test bindings.
process.env.MACHINES_AGENT_PREFER = "";
