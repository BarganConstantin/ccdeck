import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("retains the log tail without retaining discarded multi-megabyte chunks", () => {
  const moduleUrl = new URL("../../server/forge-http.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { createForgeTransport } from ${JSON.stringify(moduleUrl)};
    const tailLines = Array.from({length:80},(_,i)=>("line "+i+" "+"tail content ".repeat(8)).trimEnd());
    const transport = createForgeTransport({token:"",authHeaders:()=>({}),allowedOrigins:["https://forge.example"],
      fetchImpl:async()=>new Response("discarded "+"x".repeat(2*1024*1024)+"\\n"+tailLines.join("\\n"))});
    // Warm platform/Response machinery before measuring the retained results.
    await transport.tail("https://forge.example/log");
    global.gc();const before=process.memoryUsage().heapUsed;
    const results=[];
    for(let i=0;i<12;i++)results.push(await transport.tail("https://forge.example/log",{lines:80}));
    global.gc();
    console.log(JSON.stringify({retained:process.memoryUsage().heapUsed-before,
      exact:results.every(r=>r.truncated&&r.lines.length===80&&r.lines.every((line,i)=>line===tailLines[i]))}));
  `], { encoding: "utf8", timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  const measured = JSON.parse(result.stdout);
  expect(measured.exact).toBe(true);
  expect(measured.retained).toBeLessThan(5 * 1024 * 1024);
});
