import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { shortPreview } from "../tool-calls";

// The bundle pulls in the i18n catalogs, which vite finds by import.meta.glob;
// esbuild alone has no glob, and the memory check needs no text.
const noGlob = { "import.meta.glob": "__noGlob" };
const NO_GLOB = "globalThis.__noGlob = () => ({});\n";

describe("tool preview retention", () => {
  it("keeps the same visible preview for strings, structured results and Unicode", () => {
    for (const value of ["hello", "x".repeat(100), { output: "x".repeat(100) }, "🙂".repeat(100)]) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      expect(shortPreview(value)).toBe(text.length > 80 ? text.slice(0, 79) + "…" : text);
    }
  });
  it("releases trimmed inputs while keeping every tool and recent full input", () => {
    const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("../reducer.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, define: noGlob }).outputFiles[0].text;
    const script = NO_GLOB + bundle + `
      let state=initialState(),seq=0;
      function event(payload){state=applyEvent(state,{seq:++seq,epoch:"memory",receivedAt:Date.now(),source:"hook",payload:{session_id:"synthetic",...payload}})}
      global.gc();const before=process.memoryUsage().heapUsed;
      event({hook_event_name:"SessionStart",cwd:"/synthetic"});
      for(let i=0;i<80;i++){
        event({hook_event_name:"PreToolUse",tool_name:"Write",tool_use_id:"t"+i,tool_input:{content:String(i)+"x".repeat(1048576)}});
        event({hook_event_name:"PostToolUse",tool_name:"Write",tool_use_id:"t"+i,tool_response:{ok:true}});
      }
      global.gc();const tools=[...state.agents.values()].flatMap(a=>a.tools);
      console.log(JSON.stringify({tools:tools.length,fullInputs:tools.filter(t=>t.input!==undefined).length,retained:process.memoryUsage().heapUsed-before}));
    `;
    const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module"], { input: script, encoding: "utf8", timeout: 15000 });
    expect(result.status, `${result.error ?? ""} ${result.signal ?? ""} ${result.stderr}`).toBe(0);
    const reading = JSON.parse(result.stdout);
    expect(reading.tools).toBe(80);
    expect(reading.fullInputs).toBe(25);
    expect(reading.retained).toBeLessThan(35 * 1024 * 1024);
  });

  it("does not retain large result strings through tiny previews", () => {
    const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("../tool-calls.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, define: noGlob }).outputFiles[0].text;
    const script = NO_GLOB + bundle + `
      global.gc(); const before=process.memoryUsage().heapUsed;
      const previews=[];
      for(let i=0;i<60;i++) previews.push(shortPreview({output: String(i)+"x".repeat(1048576)}));
      global.gc(); console.log(JSON.stringify({chars:previews.reduce((n,s)=>n+s.length,0),retained:process.memoryUsage().heapUsed-before}));
    `;
    const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module"], { input: script, encoding: "utf8", timeout: 15000 });
    expect(result.status, `${result.error ?? ""} ${result.signal ?? ""} ${result.stderr}`).toBe(0);
    const reading = JSON.parse(result.stdout);
    expect(reading.chars).toBe(4800);
    expect(reading.retained).toBeLessThan(4 * 1024 * 1024);
  });
});
