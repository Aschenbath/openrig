import stringWidth from "string-width";
import { isComposerFooter } from "./startup-submission-evidence.js";

export interface ComposerSnapshot {
  screen: string;
  cursor: { x: number; y: number; width: number; height: number };
  inMode: boolean;
}

export interface ComposerInput {
  state: "empty" | "text" | "unknown";
  rows: string[];
  columns: number;
  cursorAtEnd: boolean;
  collapsedPaste: string | null;
}

const unknown = (): ComposerInput => ({ state: "unknown", rows: [], columns: 0, cursorAtEnd: false, collapsedPaste: null });
const rule = (line: string): boolean => /^[─━═-]{6,}(?: .+ [─━═-]+)?$/.test(line.trim());
const codexFooter = (line: string): boolean => isComposerFooter(line)
  || /(?:\b\d+% context left\b|\bContext \[)/.test(line);
const emptyPlaceholder = (text: string): boolean => text === "Ask Codex to do anything" || text === "Press up to edit queued messages";
const collapsedPaste = /^\[Pasted text #\d+ \+(\d+) lines\]$/;

/** Keep faint styling only as evidence for an empty placeholder. Plain text with
 * the same spelling can be a real draft whose cursor was moved with Home/C-a.
 */
function styledLines(screen: string) {
  let faint = false;
  return screen.replace(/\r\n/g, "\n").split("\n").map(raw => {
    let text = "", offset = 0;
    const faintCells: boolean[] = [];
    const append = (value: string) => { text += value; faintCells.push(...Array<boolean>(value.length).fill(faint)); };
    for (const match of raw.matchAll(/\x1b\[([0-9;:]*)m/g)) {
      append(raw.slice(offset, match.index));
      const codes = match[1]!.split(";");
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (/^(?:38|48|58):/.test(code)) continue; // Colon-form color is one parameter.
        if (code === "38" || code === "48" || code === "58") {
          const skip = codes[i + 1] === "5" ? 2 : codes[i + 1] === "2" ? (codes[i + 2] === "" ? 5 : 4) : 0;
          // Color channels are not style codes. Ambiguous compound sequences
          // provide no faint-style proof, rather than interpreting an RGB 2 as dim.
          if (!skip || i + skip !== codes.length - 1) { faint = false; break; }
          i += skip;
        } else if (code === "" || code === "0" || code === "22") faint = false;
        else if (code === "2") faint = true;
      }
      offset = match.index! + match[0].length;
    }
    append(raw.slice(offset));
    return { text, faintCells };
  });
}

/** Inspect only the visible input containing the current cursor. Activity, hook
 * freshness and text elsewhere in the pane are not evidence that input is empty.
 */
export function inspectComposerInput(snapshot: ComposerSnapshot | null): ComposerInput {
  if (!snapshot || snapshot.inMode) return unknown();
  const { x, y, width, height } = snapshot.cursor;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || x >= width || y >= height || width < 3 || height < 1) return unknown();
  const styled = styledLines(snapshot.screen);
  const lines = styled.map(line => line.text);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > height || !lines[y]) return unknown();
  const candidates: ComposerInput[] = [];
  for (let start = 0; start <= y; start++) {
    const prompt = /^( *)([❯›»])(?: (.*)|$)/.exec(lines[start] ?? "");
    if (!prompt || /^\d+[.)]\s/.test(prompt[3] ?? "")) continue;
    const prefix = prompt[1]!.length + 2;
    let end = -1;
    if (prompt[2] === "❯") {
      if (!rule(lines[start - 1] ?? "")) continue;
      for (let i = start + 1; i < lines.length; i++) {
        const footer = lines.slice(i + 1).find(line => line.trim())?.trim() ?? "";
        if (rule(lines[i]!) && isComposerFooter(footer)) { end = i; break; }
      }
    } else {
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i]!.trim()) continue;
        const tail = lines.slice(i + 1).filter(line => line.trim());
        if (lines[i + 1]?.trim() && tail.length === 1 && codexFooter(tail[0]!.trim())) { end = i; break; }
      }
    }
    if (end <= y || x < prefix) continue;
    const rows = [prompt[3] ?? ""];
    let valid = true;
    for (let i = start + 1; i < end; i++) {
      const line = lines[i]!;
      if (line.trim() && !line.startsWith(" ".repeat(prefix))) { valid = false; break; }
      rows.push(line.slice(prefix));
    }
    if (!valid) continue;
    const visible = rows.map(line => line.trimEnd());
    const atStart = y === start && x === prefix;
    const placeholder = emptyPlaceholder(rows[0]!) && styled[start]!.faintCells.slice(prefix, prefix + rows[0]!.length).every(Boolean);
    const empty = atStart && rows.length === 1 && (rows[0] === "" || placeholder);
    const last = visible.length - 1;
    const cursorAtEnd = y === start + last && x === prefix + stringWidth(visible[last] ?? "");
    const label = visible.length === 1 && collapsedPaste.test(visible[0]!) ? visible[0]! : null;
    candidates.push({ state: empty ? "empty" : "text", rows: visible, columns: width - prefix, cursorAtEnd, collapsedPaste: label });
  }
  return candidates.length === 1 ? candidates[0]! : unknown();
}

/** Preserve characters and spaces within rows. Only a real line break, a full
 * terminal row, or a word that cannot fit may explain a rendered row boundary.
 */
export function composerContainsOwnedText(input: ComposerInput, expected: string): boolean {
  if (input.state !== "text" || !input.cursorAtEnd || input.collapsedPaste || !input.rows.length) return false;
  const text = expected.replace(/\r\n/g, "\n");
  let offsets = new Set([0]);
  for (let index = 0; index < input.rows.length; index++) {
    const row = input.rows[index]!;
    const next = new Set<number>();
    for (const offset of offsets) {
      if (!text.startsWith(row, offset)) continue;
      const end = offset + row.length;
      if (index === input.rows.length - 1) { if (end === text.length) return true; continue; }
      if (text[end] === "\n") next.add(end + 1);
      if (stringWidth(row) >= input.columns) next.add(end);
      if (text[end] === " ") {
        const word = /^\S+/.exec(text.slice(end + 1))?.[0] ?? "";
        if (word && stringWidth(row + " " + word) > input.columns) next.add(end + 1);
      }
    }
    offsets = next;
    if (!offsets.size) return false;
  }
  return false;
}

/** An opaque label may be remembered only immediately after this lease pasted
 * the text. Subsequent submission requires that same complete label and cursor.
 */
export function ownCollapsedPaste(input: ComposerInput, expected: string): string | null {
  const match = input.collapsedPaste && input.cursorAtEnd ? collapsedPaste.exec(input.collapsedPaste) : null;
  return match && Number(match[1]) === expected.split("\n").length - 1 ? input.collapsedPaste : null;
}
