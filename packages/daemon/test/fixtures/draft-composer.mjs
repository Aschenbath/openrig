// A deterministic editable terminal, not a provider emulator. It consumes real
// bracketed paste/Enter bytes so the native test can count actual submissions.
import { writeFileSync, renameSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import stringWidth from "string-width";

const [runtime, stateFile] = process.argv.slice(2);
let input = "", pending = "", pasting = false;
const submissions = [];
const decoder = new StringDecoder("utf8");

function render() {
  const rows = ["Editable delivery fixture", ...submissions.slice(-3).flatMap(text => text.split("\n"))];
  if (runtime === "claude") rows.push("────────────────────────────────────────");
  const start = rows.length;
  const body = input.split("\n");
  const displayed = input || (runtime === "codex" ? "Ask Codex to do anything" : "");
  rows.push(`${runtime === "claude" ? "❯\u00a0" : "› "}${displayed.split("\n")[0]}`, ...body.slice(1).map(line => `  ${line}`));
  rows.push(...(runtime === "claude" ? ["────────────────────────────────────────", "? for shortcuts"] : ["", "fixture · 90% context left"]));
  process.stdout.write(`\x1b[2J\x1b[H${rows.join("\r\n")}\x1b[${start + body.length};${3 + stringWidth(body.at(-1))}H`);
  writeFileSync(`${stateFile}.tmp`, JSON.stringify({ input, submissions }));
  renameSync(`${stateFile}.tmp`, stateFile);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", data => {
  pending += decoder.write(data);
  while (pending.length) {
    if (pending.startsWith("\x1b[200~")) { pasting = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { pasting = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\x1b" && pending.length < 6) break;
    const char = pending[0]; pending = pending.slice(1);
    if (pasting) input += char === "\r" ? "\n" : char;
    else if (char === "\r" || char === "\n") { submissions.push(input); input = ""; }
    else if (char === "\x15") input = "";
    else if (char === "\x7f") input = input.slice(0, -1);
    else if (char >= " ") input += char;
  }
  render();
});
render();
