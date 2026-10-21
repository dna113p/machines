# Contributor guidance

Read [Architecture](docs/architecture.md) when changing runtime, launcher, host,
session, or adapter boundaries. XState owns transitions; Machines own workflow
policy; adapters translate external input and output.

For workflow definitions or the authoring skill, read
[Authoring Machines](docs/authoring.md). Keep reusable authoring instructions in
`skills/machine-builder/SKILL.md` and implementation guidance here.
Keep coordinating-agent guidance for delegating work through Machines in
`skills/machine-delegation/SKILL.md`. Project orchestrator setup belongs in
`skills/machine-project-setup/SKILL.md`: choose and build project workflow coverage,
then route normal assignments through delegation. This is agent guidance, not a
new runtime scheduler or a fixed set of development workflows.

Develop against source TypeScript with explicit `.ts` relative imports. Build
output is generated under `dist/`; portable plugin output is under `build/`.
Preserve both source and emitted-JavaScript execution when resolving workers,
child entry points, or assets.

Validate behavior changes with focused public-interface tests, then `npm run check`.
For entry-point, dependency, export, or asset changes also run the package and plugin
smoke checks listed in the README. Real Agent tests need explicit local setup;
deterministic tests use fake runners and temporary workspaces.

Documents under `docs/history/` are historical evidence, not active phase gates.

<!-- drip:reporting -->
## Reporting through Drip

Use Drip for work that may outlast the person's attention: more than a few
minutes, or started from Drip or a phone. Read the `drip-briefing` skill
before reporting; use `drip_guide` if the skill is unavailable. At the start,
use `drip_projects` to find the registered project holding this folder, then
open a thread with `drip_open`. Keep the person's ask in their own words.
If no project matches, say which folder needs registration and continue.
Keep the thread's recap current with `drip_recap`: on opening, after each
milestone, before each question, and when the work drifts from the ask.
Write its `now` as a sentence about where the work stands, never a name and
state label. Say what changed and what the person needs to do. Ask blocking
questions with `drip_ask`; distinguish restricted choices from suggestions,
and explain each choice's effect and your recommendation. Attach a page to
its recap or question when useful; keep the text able to stand alone.
Read and answer the person's messages returned by the tools. When finished,
close the thread with `drip_close` and a final result. Say "Nothing needed."
once when there is nothing for the person to do.
<!-- /drip:reporting -->
