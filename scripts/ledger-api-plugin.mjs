/**
 * Mounts the ledger API on the Vite dev server.
 *
 * The handler is the same one `omakei-serve.mjs` runs, so development and an
 * installed plugin exercise identical disk code — the previous dev-only
 * statement loader meant every installer ran a path nobody tested by hand.
 */
import { createLedgerApi } from "./ledger-api.mjs";

export function ledgerApiPlugin() {
  return {
    name: "omakei:ledger-api",
    apply: "serve",
    configureServer(server) {
      const api = createLedgerApi();
      server.middlewares.use((req, res, next) => {
        api.handle(req, res).then(
          (handled) => {
            if (!handled) next();
          },
          (err) => next(err),
        );
      });
    },
  };
}
