# web/lib/

## Responsibility
Provides network transport adapters and protocol decoders connecting Vercel AI SDK client hooks to Jobnova's backend SSE streaming endpoints.

## Design
- **Custom AI SDK Transport (`ChatTransport`)**: `JobnovaTransport` implements the AI SDK transport interface to bridge custom Server-Sent Events to `UIMessage` streams.
- **Protocol Translation (`careerEventsToMessageChunks`)**: Decodes SSE records into typed UI message chunks:
  - `text_delta` → `text-start`, `text-delta`, `text-end`
  - `tool` → `data-activity`
  - `interaction` → `data-interaction` (inline private prompts, approvals, confirmations)
  - `status` → transient `data-status` indicators
- **Reconnection & Stream Resumption**: `reconnectToStream` enables the user to respond to an interaction card and resume the active server turn without injecting a synthetic user message into the chat history.

## Flow
1. `ChatWorkspace` instantiates `JobnovaTransport` with access code supplier.
2. `sendMessage()` calls `ensureSession()`, obtaining a `sessionId` via `POST /api/chat`, then posts the message to `/api/chat/:id/message`.
3. `careerEventsToMessageChunks` reads incoming stream, decoding SSE packets and enqueuing them to the AI SDK controller.
4. On interaction response, `setResponse(value)` followed by `reconnectToStream()` resumes the agent loop via `POST /api/chat/:id/respond`.

## Integration
- **Consumed by**: `web/app/page.tsx`.
- **Dependencies**: `ai` (`@ai-sdk/react`).
