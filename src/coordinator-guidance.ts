// Shared adapter guidance, not runtime routing policy. Machines still own transitions.
export const machineDiscoveryDescription = "Before delegating work or starting multi-step implementation, debugging, review, or verification, list available Machines, their purpose, Agent roles, and missing bindings.";

export const machineCoordinatorGuidelines = [
  "Before delegating work or starting multi-step implementation, debugging, review, or verification, use machine_list in the target workspace. The user does not need to name Machines.",
  "Read a candidate's source and input/effect contract, then use a suitable Machine rather than reproducing its workflow manually or launching native sub-agents. Discovery alone is not adoption.",
  "Use the smallest useful workflow. Reuse, adapt, or create a task-scoped Machine when sequencing, verification, retries, or Human decisions matter, even for a one-off task. Keep trivial edits, simple answers, and single read-only commands direct.",
  "Use deterministic Operations for mechanical checks; do not launch another model just to run commands or repeat work the current agent can do. Select required Agent presets with machine_agents rather than inventing bindings.",
  "If already executing a Machine Agent state, perform that assigned state directly. Do not recursively delegate it unless the assignment explicitly requires bounded nested work.",
  "Machine adoption does not authorize paid model calls, broader permissions, global installation, commits, publishing, or answering Human decisions on the user's behalf. Preserve the task's existing authorization and budget.",
  "When Machines are unavailable or no safe workflow fits, state the concrete reason and continue directly when authorized; do not silently bypass a suitable Machine or force unnecessary ceremony.",
] as const;

export const machineSupervisionGuidelines = [
  "machine_start is asynchronous; continue independent work and use machine_status for authoritative progress. Preserve the exact run id and inspect the final state and result evidence before claiming success.",
  "Use machine_respond only after the Human's answer is clear, with the exact run id and current human.requestId. A waiting Human step is not permission to guess approval.",
] as const;
