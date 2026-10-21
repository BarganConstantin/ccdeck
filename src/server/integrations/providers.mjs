// Every tracker this deck can connect to, registered once (#2178). This deck
// registers none: the providers are not part of it. GET /api/integrations
// lists no provider, so the page offers no integration; a connection saved
// before is still listed, and can always be disconnected.
//
// A provider is one import and one registerProvider call here, plus its web
// half (src/web/integrations/registry.ts). registry.mjs has the contract.
