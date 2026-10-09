# Contributing

Open an issue for a bug or proposed change, or send a pull request with a focused fix.

Follow the local development setup in [README.md](README.md). Build the frontends before running workspace Rust tests on a fresh checkout.

Before submitting changes, run the checks relevant to your work:

```powershell
npm run check
npm run build
npm test
cargo test --workspace --locked
```

For desktop workflow changes, also build and run the desktop integration tests when the required Windows drivers are available.

Preserve the existing UI style, shared staff access and append-only audit behavior. Keep checker and staff commands separate. Add new database changes as migrations rather than editing migrations already deployed.

Do not commit credentials, real license keys, raw machine identifiers, webhook URLs, local databases or production configuration. Use synthetic fixtures in tests. Do not run production tests against someone else's deployment.

Describe the resulting behavior, validation performed and any migration requirements in your pull request. Contributions are licensed under the project's MIT license.
