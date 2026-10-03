interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
}
interface Document {
  readonly modelContext?: {
    registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): void | Promise<void>;
  };
}
