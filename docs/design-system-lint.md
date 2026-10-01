# Design-system lint

Run `bun run lint` after UI changes. This runs ESLint with zero warnings allowed,
then React Doctor across the full project, blocking on warnings and errors.
There is no separate doctor script.

React Doctor is pinned in `devDependencies` and runs through Bun. Its worker pool
uses Node IPC channel methods that Bun 1.4.2 does not implement, so the lint command
sets `REACT_DOCTOR_DISABLE_OXLINT_WORKER_POOL=1` to use Doctor's subprocess runner.
All diagnostics remain enabled. Score uploads and crash reporting are disabled.

`doctor.config.json` excludes generated `dist/` artifacts, matching the source lint
boundary. Bun places both server and browser chunks there; the directory is not a
public web root. Source checks cover the entire project, including `src/server/`,
without rule overrides or inline suppressions. PostgreSQL storage and workspace
persistence live in `src/server/` and cannot be imported by browser components.

`eslint.config.mjs` registers `@shadcn/lint` alongside React, React Hooks, accessibility, and TypeScript
checks. It enables the five core rules from the
[adoption guide](https://github.com/shadcn-ui/lint/blob/main/docs/adoption.md):

- `no-restyle`: callers control layout; components own their appearance.
- `no-raw-colors`: use semantic theme colors.
- `no-arbitrary-values`: use tokens or scale values, with layout values allowed.
- `no-inline-styles`: use classes and CSS custom properties for runtime values.
- `require-static-classes`: write complete, statically readable class names.

Component appearances belong in named variants, such as dashboard cards, log-level badges,
inline/code inputs, and unlimited-budget controls.

Theme tokens live in `src/index.css`. Console tokens intentionally keep a
dark surface in both themes. Workspace surfaces and small text tokens preserve
the existing dashboard design.

As recommended upstream, `src/components/ui/**` owns its styling and is exempt
from `no-restyle`, `no-arbitrary-values`, and `require-static-classes`.
Color and inline-style checks still apply. Chart series use the theme's
`--chart-*` tokens directly rather than injecting per-chart style elements.

Edit the `rules` in `eslint.config.mjs` to evolve this policy.
See the [available rules](https://github.com/shadcn-ui/lint#rules) and
[configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md).
