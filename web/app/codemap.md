# web/app/

## Responsibility
The chat window: invite-code gate, career chat, quick resolver, and approval cards.

## Design
- **One page**: `Home` holds the access-code state; `AccessGate` checks the code against `/api/eval` and remembers it in `localStorage`.
- **`ChatWorkspace`**: AI SDK `useChat` with `JobnovaTransport` for live career chat.
- **`ResolverCard`**: slide-over that resolves a LinkedIn URL with live polling and screenshots.
- **`InteractionCard`**: inline cards for missing-value answers, answer approvals, and the submit confirmation.
- **Live feedback**: tool activity badges (`started`, `completed`, `failed`) and links straight to resolved ATS pages.

## Flow
1. User enters site; if no valid code is found in `localStorage`, `AccessGate` prompts for code.
2. User enters invite code; client tests code via `GET /api/eval`.
3. Upon acceptance, `ChatWorkspace` mounts and connects to the career agent.
4. Messages stream assistant responses, browser activity chips, and private interaction cards.
5. "Quick resolve" button toggles `ResolverCard` for ad-hoc LinkedIn URL resolution.

## Integration
- **Consumed by**: Next.js build pipeline (`next build web`), served by `src/server.ts`.
- **Dependencies**: `web/lib/jobnova-transport.ts`, `@ai-sdk/react`, `lucide-react`, `react`.
