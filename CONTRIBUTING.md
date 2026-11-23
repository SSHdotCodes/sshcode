# Contributing

Thanks for helping. Bug reports, focused fixes and small improvements are the most useful
contributions. For a larger feature or a change of behavior, open a Discussion first so the scope
is agreed before you write code.

## Setup

See the [development runbook](docs/operations/development.md#first-checkout): install
[Vite+](https://viteplus.dev/guide/), then `vp i` and `vp run dev`. [AGENTS.md](AGENTS.md) describes
the architecture, the conventions the code follows and the mistakes that are easy to make; it is
written for coding agents and is just as useful for people.

Never point a development server at your real data. Worktrees use their own `.t3` folder, and
`vp run migrate-dev-db` copies a snapshot to test with.

## One problem per pull request

- Fix one underlying problem. Split unrelated fixes into separate PRs.
- Use a conventional commit title in plain language: `fix(web): new threads no longer spike CPU`.
- Explain the problem in a sentence or two, then how you fixed it.
- Check every surface the change reaches: web, desktop and mobile; each provider adapter; local,
  network and remote connections. Say which ones applied.
- UI changes need before and after screenshots; motion needs a short video.

## Verify

Run the tests and typecheck of each package you touched, from that package's directory:

```bash
cd apps/server && vp test run src/path/to/file.test.ts && vp run typecheck
```

`scripts/suites.sh LOG` runs every package's typecheck and full suite (it takes a while; CI runs
the same checks). Server changes ship with focused tests. Tests remove the temporary folders they
create and never wait on sleeps; see [AGENTS.md](AGENTS.md#verifying).

## Code style

The server is built on [Effect](https://effect.website); read
[Effect services](docs/internals/effect-services.md) before adding server code. Server and shared
code use Effect's `Clock` and `DateTime`, never `Date.now()`. The web app is compiled with the React
Compiler. Shared contracts live in `packages/contracts`; change the schema and every client follows.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License in
[LICENSE](LICENSE).
