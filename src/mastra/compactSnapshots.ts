interface ToolInvocationPart {
  type: string;
  toolInvocation?: {
    toolName?: string;
    result?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface MessageWithParts {
  parts?: ToolInvocationPart[];
  [key: string]: unknown;
}

const compactableTools = new Set(["browser_snapshot", "inspect_current_page"]);

/** Keeps current page evidence while removing obsolete browser state from the next model request. */
export function compactSupersededSnapshots<T extends MessageWithParts>(messages: T[]): T[] {
  const results = new Map<string, Array<{ messageIndex: number; partIndex: number }>>();
  messages.forEach((message, messageIndex) => {
    message.parts?.forEach((part, partIndex) => {
      const toolName = part.toolInvocation?.toolName;
      if (part.type !== "tool-invocation" || !toolName || !compactableTools.has(toolName)) return;
      results.set(toolName, [...(results.get(toolName) ?? []), { messageIndex, partIndex }]);
    });
  });

  const obsolete = new Set([...results.values()].flatMap((items) =>
    items.slice(0, -1).map(({ messageIndex, partIndex }) => `${messageIndex}:${partIndex}`)));
  if (obsolete.size === 0) return messages;

  return messages.map((message, messageIndex) => {
    if (!message.parts) return message;
    return {
      ...message,
      parts: message.parts.map((part, partIndex) => {
        if (!obsolete.has(`${messageIndex}:${partIndex}`)) return part;
        const toolName = part.toolInvocation?.toolName;
        return {
          ...part,
          toolInvocation: {
            ...part.toolInvocation,
            result: {
              success: true,
              superseded: true,
              message: `[${toolName} superseded; use only the latest result.]`,
            },
          },
        };
      }),
    };
  }) as T[];
}
