// Every tracker this deck can connect to, registered once (#2178). This deck
// registers none: the providers are not part of it, and GET /api/integrations
// lists no provider.
//
// A provider is one import and one registerProvider call here, plus its web
// half (src/web/integrations/registry.ts). registry.mjs has the contract.
