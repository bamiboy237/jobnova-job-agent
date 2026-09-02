"use client";

import { useChat } from "@ai-sdk/react";
import {
  ArrowUp,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  Search,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  JobnovaTransport,
  type ActivityData,
  type CareerInteraction,
  type JobnovaMessage,
} from "../lib/jobnova-transport";

interface RunResponse {
  status: "queued" | "running" | "completed" | "failed";
  result?: {
    success: boolean;
    company?: string;
    jobTitle?: string;
    externalJobUrl?: string;
    error?: string;
  };
  runtimeMs: number;
  trace: string[];
  screenshotUrls: string[];
}

interface EvaluationCase {
  case: string | number;
  company?: string;
  jobTitle?: string;
  correct: boolean;
  runtimeMs?: number;
  failureReason?: string;
}

export default function Home() {
  const [accessCode, setAccessCode] = useState("");
  const [accessReady, setAccessReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [resolverOpen, setResolverOpen] = useState(false);
  const [evaluation, setEvaluation] = useState<{ summary: null | { correct: number; total: number }; cases: EvaluationCase[] }>({ summary: null, cases: [] });

  useEffect(() => {
    const saved = localStorage.getItem("jobnovaAccessCode") || "";
    setAccessCode(saved);
    setAccessReady(Boolean(saved));
  }, []);

  const api = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        "x-access-code": accessCode,
        ...options.headers,
      },
    });
    if (response.status === 401) {
      setAccessReady(false);
      throw new Error("Enter a valid invite code to continue.");
    }
    return response;
  };

  useEffect(() => {
    if (!accessReady) return;
    api("/api/eval")
      .then(async (response) => {
        if (!response.ok) throw new Error("Invite code was not accepted.");
        setEvaluation(await response.json());
      })
      .catch(() => setAccessReady(false));
    // `api` intentionally reads the current access code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessReady, accessCode]);

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        evaluation={evaluation}
        onClose={() => setSidebarOpen(false)}
        onChangeCode={() => setAccessReady(false)}
      />
      <main className="chat-main">
        <header className="mobile-header">
          <button className="icon-button" type="button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="mobile-brand"><LogoMark /> Jobnova</div>
          <button className="header-action" type="button" onClick={() => setResolverOpen((open) => !open)}>
            <Search size={17} /> Resolve
          </button>
        </header>
        <ChatWorkspace
          accessCode={accessCode}
          api={api}
          resolverOpen={resolverOpen}
          setResolverOpen={setResolverOpen}
        />
      </main>
      {!accessReady && (
        <AccessGate
          initialCode={accessCode}
          onAccepted={(code) => {
            localStorage.setItem("jobnovaAccessCode", code);
            setAccessCode(code);
            setAccessReady(true);
          }}
        />
      )}
    </div>
  );
}

function Sidebar({
  open,
  evaluation,
  onClose,
  onChangeCode,
}: {
  open: boolean;
  evaluation: { summary: null | { correct: number; total: number }; cases: EvaluationCase[] };
  onClose: () => void;
  onChangeCode: () => void;
}) {
  return (
    <>
      {open && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <a className="brand" href="/"><LogoMark /> <span>Jobnova</span></a>
          <button className="icon-button mobile-only" type="button" aria-label="Close navigation" onClick={onClose}>
            <PanelLeftClose size={19} />
          </button>
        </div>
        <div className="sidebar-section">
          <p className="sidebar-label">Workspace</p>
          <div className="nav-item nav-item-active"><BriefcaseBusiness size={17} /> Career agent</div>
        </div>
        <div className="sidebar-section evaluation-summary">
          <p className="sidebar-label">Resolver evidence</p>
          <div className="score-row">
            <strong>{evaluation.summary ? `${evaluation.summary.correct}/${evaluation.summary.total}` : "Pending"}</strong>
            <span>Frozen cases</span>
          </div>
          {evaluation.cases.length > 0 ? (
            <div className="case-list">
              {evaluation.cases.slice(0, 5).map((item) => (
                <div className="case-row" key={item.case}>
                  {item.correct ? <Check size={15} /> : <X size={15} />}
                  <span>{item.company || `Case ${item.case}`}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="sidebar-note">The owner has not imported the local 20-case run.</p>
          )}
        </div>
        <div className="sidebar-footer">
          <div><ShieldCheck size={17} /><span>Private values stay out of chat</span></div>
          <button type="button" onClick={onChangeCode}>Change invite code</button>
        </div>
      </aside>
    </>
  );
}

function ChatWorkspace({
  accessCode,
  api,
  resolverOpen,
  setResolverOpen,
}: {
  accessCode: string;
  api: (path: string, options?: RequestInit) => Promise<Response>;
  resolverOpen: boolean;
  setResolverOpen: (open: boolean) => void;
}) {
  const transport = useMemo(() => new JobnovaTransport(() => accessCode), [accessCode]);
  const { messages, sendMessage, resumeStream, status, error, stop } = useChat<JobnovaMessage>({
    transport,
    onError: () => {},
  });
  const [input, setInput] = useState("");
  const [responded, setResponded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  useEffect(() => () => { void transport.end(); }, [transport]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  };

  const respond = async (interaction: CareerInteraction, value: string) => {
    setResponded((current) => new Set(current).add(interaction.requestId));
    transport.setResponse(value);
    await resumeStream();
  };

  return (
    <div className="conversation">
      <div className="desktop-chat-header">
        <div>
          <h1>Career agent</h1>
          <span>{busy ? "Working in the browser" : "Ready"}</span>
        </div>
        <button className="secondary-button" type="button" onClick={() => setResolverOpen(!resolverOpen)}>
          <Search size={17} /> Quick resolve
        </button>
      </div>

      <div className="message-scroll">
        <div className="message-column">
          {resolverOpen && <ResolverCard api={api} onClose={() => setResolverOpen(false)} />}
          {messages.length === 0 && <EmptyConversation onPrompt={(text) => void sendMessage({ text })} />}
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              responded={responded}
              onRespond={respond}
            />
          ))}
          {error && (
            <div className="blocker-row">
              <CircleAlert size={18} />
              <div><strong>Career agent blocked</strong><p>{error.message}</p></div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={1}
            placeholder="Ask about a role or paste a job URL…"
            aria-label="Message the career agent"
          />
          {busy ? (
            <button className="send-button" type="button" aria-label="Stop agent" onClick={stop}><Square size={15} fill="currentColor" /></button>
          ) : (
            <button className="send-button" type="submit" aria-label="Send message" disabled={!input.trim()}><ArrowUp size={19} /></button>
          )}
        </form>
        <p>Jobnova can make mistakes. You approve private answers and submission.</p>
      </div>
    </div>
  );
}

function Message({
  message,
  responded,
  onRespond,
}: {
  message: JobnovaMessage;
  responded: Set<string>;
  onRespond: (interaction: CareerInteraction, value: string) => Promise<void>;
}) {
  const activities = message.parts.filter(
    (part): part is typeof part & { type: "data-activity"; data: ActivityData } => part.type === "data-activity",
  );
  const latestActivities = [...new Map(activities.map((part) => [part.data.toolCallId, part])).values()];
  return (
    <article className={`message-row ${message.role}`}>
      {message.role === "assistant" && <div className="assistant-mark"><LogoMark /></div>}
      <div className="message-content">
        {message.parts.map((part, index) => {
          if (part.type === "text") return <div className="message-text" key={index}>{part.text}</div>;
          if (part.type === "data-interaction") {
            const interaction = part.data as CareerInteraction;
            if (!responded.has(interaction.requestId)) {
              return <InteractionCard interaction={interaction} onRespond={onRespond} key={interaction.requestId} />;
            }
          }
          return null;
        })}
        {latestActivities.length > 0 && (
          <details className="activity-group" open={latestActivities.some((part) => part.data.phase === "failed")}>
            <summary><Wrench size={15} /> {latestActivities.length} browser {latestActivities.length === 1 ? "activity" : "activities"} <ChevronDown size={15} /></summary>
            <div>
              {latestActivities.map((part) => (
                <div className={`activity-row ${part.data.phase}`} key={`${part.data.toolCallId}-${part.data.phase}`}>
                  {part.data.phase === "started" ? <LoaderCircle className="spin" size={14} /> : part.data.phase === "completed" ? <Check size={14} /> : <CircleAlert size={14} />}
                  <span>{toolLabel(part.data.name)}</span>
                  <small>{part.data.error || part.data.phase}</small>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

function InteractionCard({
  interaction,
  onRespond,
}: {
  interaction: CareerInteraction;
  onRespond: (interaction: CareerInteraction, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const title = interaction.kind === "submission" ? "Confirm submission" : interaction.label;
  const submitValue = async (nextValue: string) => {
    setSending(true);
    await onRespond(interaction, nextValue);
  };

  return (
    <div className="interaction-card">
      <div className="interaction-heading"><ShieldCheck size={18} /><div><strong>{title}</strong><span>Private response</span></div></div>
      {interaction.kind === "user_input" && (
        <form onSubmit={(event) => { event.preventDefault(); void submitValue(value); }}>
          {interaction.description && <p>{interaction.description}</p>}
          {interaction.options.length > 0 ? (
            <select value={value} onChange={(event) => setValue(event.target.value)} required>
              <option value="">Choose an option</option>
              {interaction.options.map((option) => <option key={option}>{option}</option>)}
            </select>
          ) : interaction.inputType === "boolean" ? (
            <select value={value} onChange={(event) => setValue(event.target.value)} required>
              <option value="">Choose an option</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          ) : (
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              type={safeInputType(interaction.inputType)}
              placeholder={interaction.formatHint || "Enter your response"}
              required
            />
          )}
          <button type="submit" disabled={!value || sending}>{sending ? "Continuing…" : "Continue privately"}</button>
        </form>
      )}
      {interaction.kind === "answer_approval" && (
        <>
          <p className="draft-answer">{interaction.draft}</p>
          <div className="interaction-actions">
            <button type="button" disabled={sending} onClick={() => void submitValue("yes")}>Approve</button>
            <button className="secondary-button" type="button" disabled={sending} onClick={() => void submitValue("no")}>Reject</button>
          </div>
        </>
      )}
      {interaction.kind === "submission" && (
        <>
          <p>{interaction.prompt}</p>
          <p className="field-count">{interaction.completedFields} fields completed</p>
          <div className="interaction-actions">
            <button type="button" disabled={sending} onClick={() => void submitValue("yes")}>Confirm one submission</button>
            <button className="secondary-button" type="button" disabled={sending} onClick={() => void submitValue("no")}>Do not submit</button>
          </div>
        </>
      )}
    </div>
  );
}

function ResolverCard({ api, onClose }: { api: (path: string, options?: RequestInit) => Promise<Response>; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [run, setRun] = useState<RunResponse>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [screenshots, setScreenshots] = useState<string[]>([]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    setRun(undefined);
    setScreenshots([]);
    try {
      const response = await api("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start the resolver.");
      const result = await pollRun(body.runId, api);
      setRun(result);
      const images = await Promise.all(result.screenshotUrls.map(async (screenshotUrl) => {
        const imageResponse = await api(screenshotUrl);
        return imageResponse.ok ? URL.createObjectURL(await imageResponse.blob()) : "";
      }));
      setScreenshots(images.filter(Boolean));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Resolver failed.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="resolver-card">
      <div className="resolver-heading">
        <div><Search size={18} /><div><strong>Quick resolve</strong><span>Find the verified employer job page</span></div></div>
        <button className="icon-button" type="button" aria-label="Close resolver" onClick={onClose}><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://www.linkedin.com/jobs/view/…" />
        <button type="submit" disabled={working}>{working ? <><LoaderCircle className="spin" size={16} /> Resolving</> : "Resolve"}</button>
      </form>
      {error && <div className="inline-error"><CircleAlert size={16} /> {error}</div>}
      {run?.result?.success && (
        <div className="resolver-result">
          <Check size={18} />
          <div>
            <strong>{run.result.jobTitle}</strong><span>{run.result.company} · {formatDuration(run.runtimeMs)}</span>
            <a href={run.result.externalJobUrl} target="_blank" rel="noreferrer">Open verified source <ExternalLink size={14} /></a>
          </div>
        </div>
      )}
      {run?.result && !run.result.success && <div className="inline-error"><CircleAlert size={16} /><span><strong>Resolver blocked</strong><br />{run.result.error}</span></div>}
      {screenshots.map((source) => <img className="resolver-screenshot" src={source} alt="Resolver browser evidence" key={source} />)}
    </section>
  );
}

function EmptyConversation({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <section className="empty-conversation">
      <div className="large-mark"><LogoMark /></div>
      <h2>How can I help with your job search?</h2>
      <p>Share a role or paste a job URL. I can resolve the source, inspect the application, and pause when your input or approval is required.</p>
      <div className="prompt-grid">
        <button type="button" onClick={() => onPrompt("Help me evaluate a role before I apply.")}><strong>Evaluate a role</strong><span>Discuss fit and tradeoffs</span></button>
        <button type="button" onClick={() => onPrompt("I have a job URL. Help me open it and apply safely.")}><strong>Start an application</strong><span>Use guarded browser tools</span></button>
      </div>
    </section>
  );
}

function AccessGate({ initialCode, onAccepted }: { initialCode: string; onAccepted: (code: string) => void }) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChecking(true);
    const response = await fetch("/api/eval", { headers: { "x-access-code": code } });
    if (response.ok) onAccepted(code);
    else setError("That invite code was not accepted.");
    setChecking(false);
  };
  return (
    <div className="gate-backdrop">
      <form className="gate-card" onSubmit={submit}>
        <div className="large-mark"><LogoMark /></div>
        <h2>Welcome to Jobnova</h2>
        <p>Enter the invite code to open the career-agent preview.</p>
        <label htmlFor="invite-code">Invite code</label>
        <input id="invite-code" type="password" value={code} onChange={(event) => setCode(event.target.value)} autoFocus required autoComplete="current-password" />
        {error && <div className="inline-error"><CircleAlert size={16} /> {error}</div>}
        <button type="submit" disabled={checking}>{checking ? "Checking…" : "Continue"}</button>
      </form>
    </div>
  );
}

function LogoMark() {
  return <span className="logo-mark" aria-hidden="true">J</span>;
}

async function pollRun(runId: string, api: (path: string, options?: RequestInit) => Promise<Response>): Promise<RunResponse> {
  while (true) {
    const response = await api(`/api/runs/${runId}`);
    const run = await response.json() as RunResponse & { error?: string };
    if (!response.ok) throw new Error(run.error || "Could not load the resolver run.");
    if (run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function toolLabel(name: string): string {
  return name.replace(/^(browser_|stagehand_)/, "").replaceAll("_", " ");
}

function safeInputType(type: string): string {
  return ["text", "date", "email", "tel", "number"].includes(type) ? type : "text";
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}
