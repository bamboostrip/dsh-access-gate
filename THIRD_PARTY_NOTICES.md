# Third-Party Notices

dsh-access-gate has **zero runtime dependencies**: the plugin only uses Node.js
built-ins (`node:crypto`, `node:http`, `node:stream`, `node:child_process`) and
the DSH / Cordis services provided by the host deployment it runs in. It
declares no `dependencies` in `package.json`.

## Development-only dependencies

Installed only when developing / building from source (`npm install`):

| Package | Version | License |
|---|---|---|
| [typescript](https://www.npmjs.com/package/typescript) | ^7.0.2 | Apache-2.0 |
| [@types/node](https://www.npmjs.com/package/@types/node) | ^26.2.0 | MIT |

These are never installed for consumers of the published package.
