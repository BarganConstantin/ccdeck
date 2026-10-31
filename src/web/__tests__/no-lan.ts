// Local network is on by default since 3.22.7, and several suites here boot a
// real deck out of a temp home with no prefs.json. Without this, every
// `npm test` would start real LAN engines that broadcast a beacon on UDP 45317
// to whatever network the machine is on, and send a pairing request to every
// real deck that hears one — including the one the developer is using.
//
// Set in the worker's own environment, which is what a spawned deck inherits:
// every suite that starts one passes `process.env` through. A suite that wants
// a LAN engine builds one directly with a deaf socket, as lan-engine.test.ts
// does, and never needs a real deck for it.
//
// Registered from vite.config.ts as a setup file, for the reason budget.ts is:
// it has to apply to the suite somebody forgets to add it to.
process.env.AGENTS_DECK_NO_LAN = "1";

// Usage reports (#1853) are on by default too, and for the same reason
// this is what keeps the suite off the network: a deck booted out of a temp
// home has no prefs.json, so without this every one of them would make an
// install id and tell api.ccdeck.dev about an install that is a test run. A
// suite that tests the reporter hands it its own env and a fake fetch.
process.env.AGENTS_DECK_NO_REPORTS = "1";

// Skill activity's typed-command hook (skill-hook.mjs) is on by default too,
// and whether it goes in depends on the Claude Code versions installed on the
// machine running the suite. Off here, every suite that installs hooks or boots
// a deck writes the same settings.json on every machine; the gate's own suite
// (skill-hook-gate-fp03) unsets it and tests the default.
process.env.AGENTS_DECK_SKILL_HOOK = "0";

// Telemetry Radar monitors by itself on every deck (traffic-radar-service.mjs):
// it samples the machine's Claude processes and captures their collector with
// tcpdump. A deck booted here would do that to the developer's own sessions,
// and spawn processes under suites that count them. Radar's suites build the
// service directly with fakes and never need a real deck for it.
process.env.AGENTS_DECK_NO_RADAR = "1";

// The ccdeck account is hidden and off by default. A developer whose shell
// exports CCDECK_ACCOUNT=1 must not switch it on in every deck the suite boots,
// nor point them at an API: a suite that tests the account turns it on itself,
// against the fake API in account-fake-api.ts.
delete process.env.CCDECK_ACCOUNT;
delete process.env.CCDECK_ACCOUNT_API;
