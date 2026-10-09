// Preloaded by `npm test`. Run-status publication is opt-in per run, so a
// developer's own MACHINES_RUN_STATUS_DIR must not make the suite write there.
delete process.env.MACHINES_RUN_STATUS_DIR;
delete process.env.MACHINES_RUN_OWNER;
delete process.env.MACHINES_RUN_PARENT;
