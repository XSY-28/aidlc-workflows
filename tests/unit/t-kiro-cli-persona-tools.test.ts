// covers: file:harness/kiro-ide/manifest.ts, file:scripts/package.ts
//
// Kiro CLI's 3.0 engine and Kiro IDE load each persona's prompt .md as an
// agent of the same name, and a dispatch runs that one (#1394): with no tools
// line the reviewer had only disclose_context, report_progress,
// subagent_response and user_input, and wrote no review. Every persona .md of
// the Kiro harness carries its tools, MCP and permissions lines.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "dist");
const KIRO_IDE = join(DIST, "kiro-ide", ".kiro", "agents");

const frontmatter = (path: string): string =>
  /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, "utf-8"))?.[1] ?? "";
const toolsOf = (path: string): string | undefined => /^tools:\s*(.+)$/m.exec(frontmatter(path))?.[1];

describe("Kiro's persona agents carry their tools on the 3.0 engine", () => {
  const personas = readdirSync(KIRO_IDE)
    .filter((file) => /^aidlc-.+-agent\.md$/.test(file))
    .sort();

  test("every persona declares the Kiro harness's tools in its .md", () => {
    expect(personas.length).toBe(14);
    for (const file of personas) {
      expect(toolsOf(join(KIRO_IDE, file)), `kiro-ide ${file}`).toBe(`["read", "write", "shell"]`);
    }
  });

  // Kiro CLI's 3.0 engine and Kiro IDE give an agent whose frontmatter sets
  // includeMcpJson every server in the person's mcp.json files; without it a
  // dispatched persona had none of them.
  test("every persona .md opts into the person's MCP servers", () => {
    for (const file of personas) {
      expect(frontmatter(join(KIRO_IDE, file)), `kiro-ide ${file}`).toMatch(/^includeMcpJson: true$/m);
    }
  });

  // The Kiro harness's own lead (Kiro IDE, and Kiro CLI on the v3 engine it
  // pins) opts in the same way, so the chat the person types into has them too.
  test("the Kiro harness's lead opts into the person's MCP servers", () => {
    expect(frontmatter(join(KIRO_IDE, "aidlc-aidlc.md"))).toMatch(/^includeMcpJson: true$/m);
  });

  test("every persona .md carries its permissions", () => {
    for (const file of personas) {
      expect(frontmatter(join(KIRO_IDE, file)), `kiro-ide ${file}`).toMatch(/^permissions:/m);
    }
  });
});
