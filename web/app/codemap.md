# web/app/

## Responsibility
Renders the client-side user interface for Jobnova, providing a minimal conversational career workspace, access code protection gate, quick job resolver panel, and inline interaction controls.

## Design
- **Single Page Application (SPA)**: Exported statically via Next.js (`output: "export"`).
- **Component Architecture**:
  - `Home`: Manages access code readiness state and root layout.
  - `AccessGate`: Modal dialog that validates invite codes against `/api/eval` before granting entry and persists to `localStorage`.
  - `Sidebar`: Displays benchmark evaluation stats and navigation controls.
  - `ChatWorkspace`: Embeds AI SDK `useChat` with `JobnovaTransport` for real-time career guidance.
  - `ResolverCard`: Collapsible slide-over allowing quick detached URL resolution with live polling and screenshot gallery.
  - `InteractionCard`: Inline cards for private form answers, free-form answer approvals, and one-click submission confirmation.
- **Evidence-First Feedback**: Real-time browser tool activity badges (`started`, `completed`, `failed`) and direct links to resolved external ATS destinations.

## Flow
1. User enters site; if no valid code is found in `localStorage`, `AccessGate` prompts for code.
2. User enters invite code; client tests code via `GET /api/eval`.
3. Upon acceptance, `ChatWorkspace` mounts and connects to the career agent.
4. Messages stream assistant responses, browser activity chips, and private interaction cards.
5. "Quick resolve" button toggles `ResolverCard` for ad-hoc LinkedIn URL resolution.

## Integration
- **Consumed by**: Next.js build pipeline (`next build web`), served by `src/server.ts`.
- **Dependencies**: `web/lib/jobnova-transport.ts`, `@ai-sdk/react`, `lucide-react`, `react`.
