export class RigNotFoundError extends Error {
  constructor(rigId: string) {
    super(`Rig ${rigId} not found`);
    this.name = "RigNotFoundError";
  }
}

export class DormantClaudeMcpExportError extends Error {
  constructor(readonly seats: string[]) {
    super(`Cannot export: claude_mcp: none is saved on seats using another runtime (${seats.join(", ")}). Switch these seats back to Claude before exporting to preserve their MCP choice.`);
    this.name = "DormantClaudeMcpExportError";
  }
}
