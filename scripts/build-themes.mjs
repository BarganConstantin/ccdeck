import { fileURLToPath } from "node:url";
import { generateThemes } from "./theme-compiler.mjs";

const check = process.argv.includes("--check");
const { themes } = generateThemes(fileURLToPath(new URL("../", import.meta.url)), { check });
console.log(`${check ? "Checked" : "Generated"} ${themes.length} JSON themes.`);
