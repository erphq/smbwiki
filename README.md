# smbwiki

Source definitions and static-site generator for
[smbwiki.com](https://smbwiki.com), a free encyclopedia of how small
businesses work.

Business types are modeled as skills, roles, documents, metrics,
software categories, licenses, markets, revenue mechanics, and supply
chain relationships. Human-readable pages and machine-readable output
are generated from the same YAML definitions.

## Build

```sh
npm ci
npm run build:graph
npm run check:catalog
npm run check:content
node scripts/build-site.mjs
npm run check:site
```

The generated site is written to `dist/`.

## Repository

This repository contains clean public release snapshots. Development
history, deployment configuration, and operational records are kept
outside the public source tree.
