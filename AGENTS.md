# Contributor guidance

Read [Architecture](docs/architecture.md) when changing runtime, launcher, host,
session, or adapter boundaries. XState owns transitions; Machines own workflow
policy; adapters translate external input and output.

For workflow definitions or the authoring skill, read
[Authoring Machines](docs/authoring.md). Keep reusable authoring instructions in
`skills/machine-builder/SKILL.md` and implementation guidance here.

Develop against source TypeScript with explicit `.ts` relative imports. Build
output is generated under `dist/`; portable plugin output is under `build/`.
Preserve both source and emitted-JavaScript execution when resolving workers,
child entry points, or assets.

Validate behavior changes with focused public-interface tests, then `npm run check`.
For entry-point, dependency, export, or asset changes also run the package and plugin
smoke checks listed in the README. Real Agent tests need explicit local setup;
deterministic tests use fake runners and temporary workspaces.

Documents under `docs/history/` are historical evidence, not active phase gates.
