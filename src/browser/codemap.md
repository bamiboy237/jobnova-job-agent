# src/browser/

## Responsibility
One CDP connection shared by the agents, on remote Browserbase or local Chrome.

## Design
- **One interface**: `CdpSession` (`connect()`, `release()`) covers both providers.
- **`BrowserbaseSession`**: provisions remote Chromium with CAPTCHA solving on and the saved LinkedIn context attached.
- **`LocalChromeSession`**: spawns local Chrome with the local profile over a debug port.
- **Lazy connect**: `connect()` is memoized, so one session serves the whole run.

## Flow
1. Agents ask for a session based on `BROWSER_PROVIDER` (`browserbase` or `local`).
2. `connect()` provisions remote Chromium or spawns local Chrome and returns the CDP URL.
3. `AgentBrowser` and Stagehand attach over CDP.
4. `release()` frees the remote session or stops local Chrome.

## Integration
- **Consumed by**: `src/mastra/resolverBrowser.ts`, `src/apply/applyBrowser.ts`, `src/career/careerSession.ts`, `src/auth.ts`.
- **Dependencies**: `@browserbasehq/sdk`, `playwright-core`, `node:child_process`, `node:net`.
