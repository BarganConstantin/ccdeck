# Third-party notices

ccdeck itself is licensed under the GNU Affero General Public License v3.0 only.
See [LICENSE](./LICENSE) and [LICENSING.md](./LICENSING.md).

This file covers software written by other people that ccdeck distributes.
Their licences are their own and are unaffected by ccdeck's licence: the
notices below must travel with any copy of ccdeck, including copies you
modify or redistribute.

## What is actually distributed

The npm package ships a browser bundle at `dist/web`, built by Vite from
`src/web`. Nothing is marked external in `vite.config.ts`, so the packages
listed here are compiled into that bundle and are physically present in the
published tarball — which is what makes these notices required rather than
merely courteous.

Two things are deliberately **not** listed:

- **Test and type tooling** (`vitest`, `typescript`, `@vitejs/plugin-react`) and
  **type-only packages** (`@types/*`). These are devDependencies that never reach
  the published bundle — `@types/*` erase at compile time.
- **The server, launcher and hook** (`src/server`, `bin`, `hook`). They import
  nothing but Node built-ins, so they carry no third-party code at all.

`vite` used to be named in that first bullet and is not any more, because it is
the exception the bullet cannot hold: it is a build tool that also **writes code
of its own into the output**. `dist/web/assets/index-*.js` OPENS with Vite's
`modulePreloadPolyfill` — the `link[rel="modulepreload"]` feature test and the
`MutationObserver` that watches for late ones — and its bundled CommonJS interop
helpers follow it. None of that comes from `src/web`; all of it is in the npm
tarball, because `dist/web` is in `package.json` `files`. So `vite` is in the
table below like any other bundled package (#962). The entry does not stop it
being a devDependency; it records that some of its code ships.

`package-lock.json` records the licences of the full dependency graph as npm
resolved it. Apart from the root `packages[""]` entry — which describes ccdeck
itself and now reads `AGPL-3.0-only` to match `package.json` — every licence
field in it belongs to a dependency and is left exactly as npm wrote it.

### Software ccdeck fetches but does not distribute

Four third-party tools are downloaded onto the user's own machine at runtime, on
demand, and are **not** in the npm tarball:

- `macmon` — github.com/vladkens/macmon, fetched as a release binary.
- `uv` — github.com/astral-sh/uv, fetched by `src/server/uv-bootstrap.mjs` when
  the machine has no way to install a Python application.
- `ccusage` — installed from npm, into a private prefix under `~/.agents-deck`.
- `claude-swap` — installed from PyPI by `src/server/cswap-install.mjs`, with
  `uv tool install` or a `pipx` fallback, and upgraded against
  `https://pypi.org/pypi/claude-swap/json`. Unlike the three above it lands in
  the user's **global** tool path and it handles Claude credentials, which is
  why the deck prints what the install did rather than doing it quietly.

This list said "three" and named the first three until #962. ccdeck runs all of
them as separate processes and reads their output; it does not link them, bundle
them or redistribute them, so their licences are not reproduced here — each
arrives with its own licence beside it. They are named for completeness, so that
"what ccdeck ships" and "what ccdeck can run" are not confused. Every one of them
is off under `AGENTS_DECK_NO_INSTALL=1`.

## Bundled packages (25)

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| `@reactflow/background` | 11.3.14 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `@reactflow/controls` | 11.2.14 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `@reactflow/core` | 11.11.4 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `@reactflow/minimap` | 11.7.14 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `@reactflow/node-resizer` | 2.2.14 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `classcat` | 5.0.5 | MIT | Copyright © Jorge Bucaran <<https://jorgebucaran.com>> |
| `d3-color` | 3.1.0 | ISC | Copyright 2010-2022 Mike Bostock |
| `d3-dispatch` | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-drag` | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-ease` | 3.0.1 | BSD-3-Clause | Copyright 2010-2021 Mike Bostock |
| `d3-interpolate` | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-selection` | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-timer` | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-transition` | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-zoom` | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| `dagre` | 0.8.5 | MIT | Copyright (c) 2012-2014 Chris Pettitt |
| `graphlib` | 2.1.8 | MIT | Copyright (c) 2012-2014 Chris Pettitt |
| `lodash` | 4.18.1 | MIT | Copyright OpenJS Foundation and other contributors <https://openjsf.org/> |
| `react` | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `react-dom` | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `reactflow` | 11.11.4 | MIT | Copyright (c) 2019-2023 webkid GmbH |
| `scheduler` | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `use-sync-external-store` | 1.6.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `vite` | 6.4.3 | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors |
| `zustand` | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel |

Every one is a permissive licence (MIT, ISC, BSD-3-Clause). All are
compatible with the GNU AGPL v3: permissively licensed code may be combined
into an AGPL-licensed work provided its copyright and permission notices are
preserved, which is the purpose of this file. None of these licences is
changed by ccdeck's relicensing, and no copyleft obligation flows back to
their authors.

### Declared but not emitted (3)

Three packages resolve into `node_modules` and do **not** survive the build.
They were in the table above until #962, which is over-attribution rather than
under-attribution and so harmless legally — but the paragraph at the top of this
file says everything in the table is *physically present in the published
tarball*, and that is a factual claim a redistributor is entitled to rely on. So
they are listed here instead, with what was looked for in the built chunks and
not found.

| Package | Version | Licence | Searched for in `dist/web/assets/*` | Why it is not there |
| --- | --- | --- | --- | --- |
| `js-tokens` | 4.0.0 | MIT | `[gmiyus]{1,6}` — a fragment of its one exported regex, which a minifier cannot rename | A browserify transform's dependency, reached only through `loose-envify`. Rollup never invokes it. |
| `loose-envify` | 1.4.0 | MIT | `[_$a-zA-Z][$\w]+` — the body of its `process.env.` matcher, likewise a regex literal | Same: it is a browserify transform, declared by `react` and never part of a Rollup graph. |
| `@reactflow/node-toolbar` | 1.3.14 | MIT | `react-flow__node-toolbar` | Tree-shaken. The deck renders no node toolbar, and unlike its siblings this one contributes no stylesheet either. |

Their licence texts are still reproduced below — §3, §6 and §7 — because dropping
a notice is the expensive mistake and keeping one is free.

`@reactflow/node-resizer` is deliberately **not** in this list, and it is the one
entry #962 got wrong. Its JavaScript is tree-shaken exactly as the toolbar's is —
`react-flow__resize-control` appears nowhere in the JS chunks — but its
stylesheet is inlined into `reactflow/dist/style.css`, which `src/web/main.tsx`
imports, and those 27 rules are in `dist/web/assets/index-*.css` and therefore in
the tarball. A search of the JS alone says it is absent; a search of what
actually ships says it is not. It stays in the bundled table.

## Full licence texts

### 1. `react` 18.3.1, `react-dom` 18.3.1, `scheduler` 0.23.2

```text
MIT License

Copyright (c) Facebook, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 2. `use-sync-external-store` 1.6.0

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3. `@reactflow/background` 11.3.14, `@reactflow/controls` 11.2.14, `@reactflow/core` 11.11.4, `@reactflow/minimap` 11.7.14, `@reactflow/node-resizer` 2.2.14, `@reactflow/node-toolbar` 1.3.14, `reactflow` 11.11.4

```text
MIT License

Copyright (c) 2019-2023 webkid GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4. `classcat` 5.0.5

```text
Copyright © Jorge Bucaran <<https://jorgebucaran.com>>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 5. `zustand` 4.5.7

```text
MIT License

Copyright (c) 2019 Paul Henschel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 6. `loose-envify` 1.4.0

```text
The MIT License (MIT)

Copyright (c) 2015 Andres Suarez <zertosh@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### 7. `js-tokens` 4.0.0

```text
The MIT License (MIT)

Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### 8. `d3-color` 3.1.0

```text
Copyright 2010-2022 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### 9. `d3-dispatch` 3.0.1, `d3-drag` 3.0.0, `d3-interpolate` 3.0.1, `d3-selection` 3.0.0, `d3-timer` 3.0.1, `d3-transition` 3.0.1, `d3-zoom` 3.0.0

```text
Copyright 2010-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### 10. `d3-ease` 3.0.1

```text
Copyright 2010-2021 Mike Bostock
Copyright 2001 Robert Penner
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 11. `dagre` 0.8.5, `graphlib` 2.1.8

```text
Copyright (c) 2012-2014 Chris Pettitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### 12. `lodash` 4.18.1

```text
Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

### 13. `vite` 6.4.3

The code Vite contributes to `dist/web` is its own — the `modulePreloadPolyfill`
that opens the entry chunk, and the CommonJS interop helpers that follow it. Both
are emitted from templates inside `vite/dist/node/chunks/`, so what ships is
covered by Vite's core licence, reproduced verbatim below from
`node_modules/vite/LICENSE.md`.

```text
MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The interop helpers Vite emits originate in `@rollup/plugin-commonjs`, which Vite
vendors into the chunks named above rather than resolving at build time — it is
not a package in this tree. Its notice travels inside `vite/LICENSE.md`, under
"Licenses of bundled dependencies", and is reproduced here too so that a reader
of this file alone has it:

```text
The MIT License (MIT)

Copyright (c) 2019 RollupJS Plugin Contributors (https://github.com/rollup/plugins/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
