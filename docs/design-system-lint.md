# Design-system lint

Run `bun run lint --max-warnings 0` after UI changes.

`eslint.config.mjs` registers `@shadcn/lint` alongside Next.js and TypeScript
checks. It enables the five core rules from the
[adoption guide](https://github.com/shadcn-ui/lint/blob/main/docs/adoption.md):

- `no-restyle`: callers control layout; components own their appearance.
- `no-raw-colors`: use semantic theme colors.
- `no-arbitrary-values`: use tokens or scale values, with layout values allowed.
- `no-inline-styles`: use classes and CSS custom properties for runtime values.
- `require-static-classes`: write complete, statically readable class names.

Component appearances belong in named variants, such as dashboard cards, log-level badges,
inline/code inputs, and unlimited-budget controls.

Theme tokens live in `src/app/globals.css`. Console tokens intentionally keep a
dark surface in both themes. Workspace surfaces and small text tokens preserve
the existing dashboard design.

As recommended upstream, `src/components/ui/**` owns its styling and is exempt
from `no-restyle`, `no-arbitrary-values`, and `require-static-classes`.
Color and inline-style checks still apply. Chart series use the theme's
`--chart-*` tokens directly rather than injecting per-chart style elements.

Edit the `rules` in `eslint.config.mjs` to evolve this policy.
See the [available rules](https://github.com/shadcn-ui/lint#rules) and
[configuration examples](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md).
