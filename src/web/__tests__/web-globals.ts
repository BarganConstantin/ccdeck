// Two web globals the page's code reaches for, put where Node 18 leaves them out.
//
// Every browser the page runs in has `File` and `crypto` (Web Crypto), and so
// does every Node from 20 on. Node 18, the oldest runtime package.json
// promises, has both but not as globals:
//
//   File    global from Node 20.0.0; `File` from node:buffer since 18.13.0
//   crypto  global from Node 19.0.0 (17.6 behind --experimental-global-webcrypto);
//           `webcrypto` from node:crypto
//
// So on Node 18 the suites that drive page code with a pasted image, a recorded
// clip or a fresh id stopped on `ReferenceError: File is not defined` or
// `crypto is not defined` before they reached anything they test. Measured on
// Node 18.20.8: 22 cases and one whole file, every one of them green on Node 22
// and 24.
//
// Each is Node's own implementation, put on globalThis only where it is
// missing, so on Node 20 and later importing this does nothing at all. The
// suites that need it import it first, for its effect.
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";

if (typeof globalThis.File === "undefined") {
  Object.defineProperty(globalThis, "File", { value: NodeFile, writable: true, configurable: true });
}
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true, configurable: true });
}
