interface ToolResultPart {
  type: string;
  toolName?: string;
  output?: unknown;
  [key: string]: unknown;
}

interface MessageWithContent {
  content: unknown;
  [key: string]: unknown;
}

const compactableTools = new Set(["browser_snapshot", "inspect_current_page"]);

/** Keeps current page evidence while removing obsolete browser state from the next model request. */
export function compactSupersededSnapshots<T extends MessageWithContent>(messages: T[]): T[] {
  const results = new Map<string, Array<{ messageIndex: number; partIndex: number }>>();
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    (message.content as ToolResultPart[]).forEach((part, partIndex) => {
      if (part.type !== "tool-result" || !part.toolName || !compactableTools.has(part.toolName)) return;
      results.set(part.toolName, [...(results.get(part.toolName) ?? []), { messageIndex, partIndex }]);
    });
  });

  const obsolete = new Set([...results.values()].flatMap((items) =>
    items.slice(0, -1).map(({ messageIndex, partIndex }) => `${messageIndex}:${partIndex}`)));
  if (obsolete.size === 0) return messages;

  return messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: (message.content as ToolResultPart[]).map((part, partIndex) => {
        if (!obsolete.has(`${messageIndex}:${partIndex}`)) return part;
        return {
          ...part,
          output: {
            success: true,
            superseded: true,
            message: `[${part.toolName} superseded; use only the latest result.]`,
          },
        };
      }),
    };
  }) as T[];
}
