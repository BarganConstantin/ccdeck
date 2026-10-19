// The trackers the deck knows how to connect to (#2178), keyed by kind.
//
// A PROVIDER is one object, registered once at import (providers.mjs). The
// core — the store, the generic connection routes, the asset route, the one
// client per connection — never names a tracker; what it needs to know about
// one is this:
//
//   {
//     kind: "jira",                       // the key, in URLs and in the store
//     label: "Jira",                      // what the page and errors call it
//     createClient(conn, secret, opts?),  // -> a client for one connection (below)
//     routes(client, method, subpath, searchParams, req, opts?)
//                                         // -> Promise<{ status, body }>: the provider's own reads
//     parseInput?(input, existing?),      // the form's values -> { baseUrl, secret, meta?, name? };
//                                         //    throws an `invalid` error naming the field.
//                                         //    Default: { baseUrl: input.baseUrl, secret: input.token },
//                                         //    a blank token keeping the saved one.
//     defaultName?(checked),              // a name for a connection the form left unnamed
//   }
//
// A CLIENT is the provider's, made for one connection and kept by the core —
// one per connection id, rebuilt when the token, the address, the kind or the
// saved connection change, and dropped when it is removed, so the short caches
// a client holds never outlive what they were read with:
//
//   {
//     allowedOrigins: string[],           // every origin its token may be sent to
//     validate(opts?) -> Promise<{ account, meta }>,
//                                         // ask the tracker who this is; throws a typed error.
//                                         //    `opts.phase` is "validate" while a form is being
//                                         //    checked (a refusal is a wrong token) and "use" for
//                                         //    Test (a refusal is an expired one). allowedOrigins
//                                         //    is read again after it: validation may find more
//                                         //    (Jira Cloud's scoped tokens answer elsewhere).
//     fetchAsset?(url, { maxBytes, signal }) -> Promise<{ contentType, bytes: Buffer }>
//                                         // an image for the asset route. The client owns
//                                         //    the read: its own image-host list, checked on
//                                         //    the URL and on every redirect hop (no loopback
//                                         //    or private address but its own origin); the
//                                         //    token on its token origins only; raster only
//                                         //    (png/jpeg/gif/webp, no SVG); a streamed cap
//                                         //    (8 MB). Throws a typed error; the route answers
//                                         //    any failure with an empty 403/404 and never
//                                         //    lets it touch the connection. Without one, the
//                                         //    route reads from allowedOrigins only, unsigned
//                                         //    (proxy.mjs's fetchImage does all of the above).
//   }
//
// `opts` to createClient is `{ fetchImpl }` (the suite's fake tracker); `opts`
// to routes is `{ signal }`, aborted when the page gives up on the request. A
// typed error — `{ kind, message, status?, retryAfter? }`, errors.mjs — thrown
// anywhere becomes the shared envelope; `errorResponse(err)` builds it for a
// provider that answers rather than throws.
//
// A provider may use the helpers here and in proxy.mjs — `createRouter` for
// its paths, `createProxy` for a transport that signs only for its origins and
// never follows a redirect elsewhere, `fetchImage` for fetchAsset — or bring
// its own (#2179's forge-http).

const providers = new Map();

/** A path pattern ("board/:boardId/sprints") against the rest of a URL. */
function compile(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return segments => {
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = segments[i];
      else if (parts[i] !== segments[i]) return null;
    }
    return params;
  };
}

/** A small GET router a provider can build its `routes` on. */
export function createRouter() {
  const routes = [];
  return {
    /** Add a GET route, relative to /api/integrations/<kind>/<connId>/. */
    get(pattern, handler) {
      if (typeof handler !== "function") throw new TypeError("route handler must be a function");
      routes.push({ match: compile(pattern), handler, pattern });
    },
    /** The route for a sub-path ("board/1/issues") or its segments, or null. */
    find(subpath) {
      const segments = Array.isArray(subpath) ? subpath : String(subpath).split("/").filter(Boolean);
      for (const route of routes) {
        const params = route.match(segments);
        if (params) return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    patterns: () => routes.map(r => r.pattern),
  };
}

const REQUIRED = ["kind", "label", "createClient", "routes"];

/** Register a provider. Its kind must be new, lower-case and URL-safe. */
export function registerProvider(provider) {
  for (const key of REQUIRED) {
    if (!provider?.[key]) throw new TypeError(`integration provider is missing ${key}`);
  }
  if (typeof provider.createClient !== "function" || typeof provider.routes !== "function") {
    throw new TypeError("createClient and routes must be functions");
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider.kind)) throw new TypeError(`bad provider kind ${provider.kind}`);
  if (providers.has(provider.kind)) throw new Error(`provider ${provider.kind} is registered twice`);
  providers.set(provider.kind, provider);
}

export function getProvider(kind) {
  return providers.get(kind) ?? null;
}

/** Every registered provider, as the page may see it: kind and label. */
export function providerList() {
  return [...providers.values()].map(provider => ({ kind: provider.kind, label: provider.label }));
}

/** For tests: forget every provider, or put one back. */
export function resetProvidersForTest() {
  providers.clear();
}
