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
