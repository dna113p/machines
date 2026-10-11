// Preloaded by `npm test`. Run-status publication is opt-in per run, so a
// developer's own MACHINES_RUN_STATUS_DIR must not make the suite write there.
delete process.env.MACHINES_RUN_STATUS_DIR;
delete process.env.MACHINES_RUN_OWNER;
delete process.env.MACHINES_RUN_PARENT;
delete process.env.MACHINES_RUN_LABEL;
// A developer's usage-limit settings must not change which preset a test run uses or how long it waits.
delete process.env.MACHINES_AGENT_FALLBACK;
delete process.env.MACHINES_AGENT_LIMIT_WAIT_MINUTES;
