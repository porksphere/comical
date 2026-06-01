# Comical

A configurable, **content-neutral** **bridge runtime** for serialized content (comics, books,
and the like) that runs the same TypeScript core on the web, iOS, Android, and desktop.
Connection behaviour is supplied by swappable **bridges**; each bridge talks to a
**user-supplied backend** (e.g. a self-hosted Komga/Kavita/OPDS library you own, or a site
you're authorized to use).

> Comical ships no content and no backends, and operates no central bridge registry. It is
> infrastructure in the same category as a web browser or an OPDS client. You bring your own
> bridge and your own backend.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Runtime** | The content-neutral engine. Ships no backends, no content. |
| **Bridge** | A plugin implementing the connector interface; translates *one* backend into the neutral data model. |
| **Backend** | The user-supplied server/site a bridge talks to. URL + credentials are user-configured, never baked in. |
| **Host** | The per-platform adapter providing the capability API (HTTP, storage, parse, log). |
| **Registry** | An optional, user-added catalog of bridges. The project operates none. |

## Layout

```
packages/
  contract/   versioned interfaces + zod models (the stable boundary)
  core/       loader, sandbox, capability API, cache, rate-limiter
  sdk/        bridge-author API (Bridge base class, cheerio helpers)
  testkit/    fixture record/replay, conformance suite, mock host
  host-bun/   desktop/CLI host adapter (Bun fetch, fs storage, vm loader)
  cli/        the `comical` command-line host
bridges/
  example-bridge/   reference bridge to a legal demo backend
```

## Develop

```sh
bun install          # install workspace deps
bun run build        # bundle bridges → bridges/<id>/dist/bridge.js
bun test             # run the offline test pyramid
bun run cli -- list  # run the CLI
```

Requires [Bun](https://bun.sh) ≥ 1.3.
