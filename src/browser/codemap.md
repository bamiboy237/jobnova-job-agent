# src/browser/

## Responsibility
Provides browser session abstractions and Chrome DevTools Protocol (CDP) connectivity for both remote (Browserbase) and local Chrome execution environments.

## Design
- **CdpSession Interface**: Defines a unified lifecycle interface (`connect(): Promise<string>`, `release(): Promise<void>`) for acquiring and closing CDP endpoints.
- **Strategy / Provider Pattern**:
  - `BrowserbaseSession`: Connects to remote managed Chromium via the `@browserbasehq/sdk`, configuring proxy settings, CAPTCHA solving, and persistent authenticated contexts.
  - `LocalChromeSession`: Spawns a local macOS Google Chrome child process on a dynamically allocated TCP port with user data dir preservation and CDP debugging enabled.
- **Lazy Singleton Connection**: `connect()` is memoized to guarantee only one active CDP connection attempt per session lifecycle.

## Flow
1. Higher-level agents/resolvers request a `CdpSession` instance based on `BROWSER_PROVIDER` (`browserbase` or `local`).
2. Calling `session.connect()` either provisions a remote Browserbase session via REST API or spawns local Chrome with `--remote-debugging-port`.
3. Returns a WebSocket CDP connection URL (`wss://...` or `ws://127.0.0.1:...`).
4. Mastra `AgentBrowser` and `Stagehand` attach Playwright instances over CDP to this endpoint.
5. `session.release()` sends `REQUEST_RELEASE` to Browserbase or gracefully terminates the local child process.

## Integration
- **Consumed by**: `src/mastra/resolverBrowser.ts`, `src/apply/applyBrowser.ts`, `src/career/careerSession.ts`, `src/auth.ts`.
- **Dependencies**: `@browserbasehq/sdk`, `playwright-core`, `node:child_process`, `node:net`.
