# Radio production QA evidence

See [release-readiness report](../../../docs/features/radio-production-readiness.md).

Final unit/integration evidence: tests-final.log (431 tests,22 suites),
typecheck.log, build.log, themes.log. Main browser: browser-final.log and
browser-results.json (25/25). browser-baseline.log preserves the reproduced
YouTube-state and map-focus defects; its original blob-URL assertion incorrectly
assumed Chrome could not use native HLS. This assertion was corrected before the
separate native and forced-MSE checks. Earlier failing harness attempts are not
counted as passes. browser-mse.log covers actual AAC decoding with native HLS
capability disabled only in the controlled context to exercise lazy hls.js.

zoom.log and browser-zoom-2.png document actual browser zoom through an isolated
extension, not simulated viewport zoom. lifecycle-final.log covers bounded
listener/node growth, synthetic pinch, invalid entries and directory recovery.
external-app-results.json records the three real application playback samples;
external-results.json records two separate direct HTMLAudioElement probes.
Axe JSON includes incomplete/manual-review items as well as violations.

The scripts need Playwright available outside production dependencies. Set
QA_PLAYWRIGHT_MODULE to its module path if it is not on your Node resolution path,
and QA_CHROME to an installed Chromium/Chrome executable if necessary. The main
browser script accepts QA_RADIO_URL (default http://127.0.0.1:5205/) and
QA_RADIO_ARTIFACTS (default /tmp/ccdeck-radio-production-qa). The other captured
scripts preserve the audit's local port/artifact directory; they use isolated
browser contexts. zoom.cjs optionally uses QA_EXTENSION_CHROME for an executable
that supports unpacked QA extensions.

Prepare the controlled media/axe fixtures in the artifact directory:

```sh
mkdir -p /tmp/ccdeck-radio-production-qa
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js -o /tmp/ccdeck-radio-production-qa/axe.min.js
ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo -t 30 -c:a aac -b:a 64k -f hls -hls_time 3 -hls_playlist_type vod -hls_segment_filename /tmp/ccdeck-radio-production-qa/segment-%03d.ts /tmp/ccdeck-radio-production-qa/fixture.m3u8
node .impeccable/qa/radio-production-2026-10-13/browser.cjs
QA_FORCE_MSE=1 node .impeccable/qa/radio-production-2026-10-13/browser.cjs
```

The application must already serve this branch's rebuilt dist/web. Nothing in
these scripts merges/publishes code or modifies a personal browser profile.
The zoom script expects an isolated extension in the artifact directory with:

```json
{"manifest_version":3,"name":"Isolated Radio QA zoom","version":"1.0","permissions":["tabs"],"background":{"service_worker":"worker.js"}}
```

worker.js contains `chrome.runtime.onInstalled.addListener(()=>{});`.
