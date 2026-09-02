"use client";

import { useChat } from "@ai-sdk/react";
import {
  ArrowRight,
  ArrowUp,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileText,
  LoaderCircle,
  Lock,
  Menu,
  PanelLeftClose,
  Search,
  Shield,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [initialResolverUrl, setInitialResolverUrl] = useState("");
  const [evaluation, setEvaluation] = useState<{
    summary: null | { correct: number; total: number };
    cases: EvaluationCase[];
  }>({ summary: null, cases: [] });

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

  const handleStartResolver = (url: string) => {
    setInitialResolverUrl(url);
    setResolverOpen(true);
  };

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        evaluation={evaluation}
        onClose={() => setSidebarOpen(false)}
        onChangeCode={() => setAccessReady(false)}
        onOpenEvidence={() => setEvidenceOpen(true)}
        onToggleResolver={() => setResolverOpen((prev) => !prev)}
        resolverActive={resolverOpen}
      />
      <main className="chat-main">
        <header className="mobile-header">
          <button
            className="icon-button"
            type="button"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="mobile-brand">
            <LogoMark /> Jobnova
          </div>
          <button
            className="header-action"
            type="button"
            onClick={() => setResolverOpen((open) => !open)}
            aria-label="Toggle resolver"
          >
            <Search size={17} /> Resolve
          </button>
        </header>

        <ChatWorkspace
          accessCode={accessCode}
          api={api}
          resolverOpen={resolverOpen}
          setResolverOpen={setResolverOpen}
          initialResolverUrl={initialResolverUrl}
          onOpenEvidence={() => setEvidenceOpen(true)}
          onStartResolver={handleStartResolver}
        />
      </main>

      {evidenceOpen && (
        <EvidenceModal
          evaluation={evaluation}
          onClose={() => setEvidenceOpen(false)}
        />
      )}

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
  onOpenEvidence,
  onToggleResolver,
  resolverActive,
}: {
  open: boolean;
  evaluation: { summary: null | { correct: number; total: number }; cases: EvaluationCase[] };
  onClose: () => void;
  onChangeCode: () => void;
  onOpenEvidence: () => void;
  onToggleResolver: () => void;
  resolverActive: boolean;
}) {
  return (
    <>
      {open && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
        />
      )}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <a className="brand" href="/">
            <LogoMark />
            <span>Jobnova</span>
          </a>
          <span className="brand-badge">Preview</span>
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <PanelLeftClose size={19} />
          </button>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-label">Workspaces</p>
          <div className="sidebar-nav">
            <button type="button" className="nav-item nav-item-active">
              <BriefcaseBusiness size={16} />
              <span>Career agent</span>
            </button>
            <button
              type="button"
              className={`nav-item ${resolverActive ? "nav-item-active" : ""}`}
              onClick={onToggleResolver}
            >
              <Search size={16} />
              <span>Quick resolve</span>
            </button>
            <button
              type="button"
              className="nav-item"
              onClick={onOpenEvidence}
            >
              <FileText size={16} />
              <span>Resolver evidence</span>
            </button>
          </div>
        </div>

        <div className="evaluation-summary-card">
          <p className="sidebar-label">Resolver evidence</p>
          <div className="score-row">
            <strong>
              {evaluation.summary
                ? `${evaluation.summary.correct}/${evaluation.summary.total}`
                : "Pending"}
            </strong>
            <span>Frozen cases</span>
          </div>

          {evaluation.cases.length > 0 ? (
            <>
              <div className="case-list">
                {evaluation.cases.slice(0, 4).map((item) => (
                  <div
                    className={`case-row ${item.correct ? "pass" : "fail"}`}
                    key={item.case}
                  >
                    {item.correct ? <Check size={14} /> : <X size={14} />}
                    <span className="case-name">
                      {item.company || `Case ${item.case}`}
                    </span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="sidebar-action-button"
                onClick={onOpenEvidence}
              >
                Inspect full ledger
              </button>
            </>
          ) : (
            <>
              <p className="sidebar-note">
                Run the local frozen 20-case suite to populate verified benchmark data.
              </p>
              <button
                type="button"
                className="sidebar-action-button"
                onClick={onOpenEvidence}
              >
                View benchmark ledger
              </button>
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-security-badge">
            <ShieldCheck size={16} />
            <span>Guarded execution: Private inputs bypass LLM prompts.</span>
          </div>
          <button type="button" onClick={onChangeCode}>
            Change invite code
          </button>
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
  initialResolverUrl,
  onOpenEvidence,
  onStartResolver,
}: {
  accessCode: string;
  api: (path: string, options?: RequestInit) => Promise<Response>;
  resolverOpen: boolean;
  setResolverOpen: (open: boolean) => void;
  initialResolverUrl?: string;
  onOpenEvidence: () => void;
  onStartResolver: (url: string) => void;
}) {
  const transport = useMemo(() => new JobnovaTransport(() => accessCode), [accessCode]);
  const { messages, sendMessage, resumeStream, status, error, stop } = useChat<JobnovaMessage>({
    transport,
    onError: () => {},
  });
  const [input, setInput] = useState("");
  const [responded, setResponded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  useEffect(() => () => { void transport.end(); }, [transport]);

  // Auto-resize composer textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [input]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    void sendMessage({ text });
  };

  const respond = async (interaction: CareerInteraction, value: string) => {
    setResponded((current) => new Set(current).add(interaction.requestId));
    transport.setResponse(value);
    await resumeStream();
  };

  const handleUseResolvedUrl = (jobTitle: string, company: string, url: string) => {
    const text = `I want to apply to ${jobTitle} at ${company}: ${url}`;
    void sendMessage({ text });
    setResolverOpen(false);
  };

  return (
    <div className="conversation">
      <div className="desktop-chat-header">
        <div className="header-meta">
          <h1>Career agent</h1>
          <div className={`status-pill ${busy ? "active" : ""}`}>
            <span className="status-dot" />
            <span>{busy ? "Working in remote browser" : "Ready"}</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className={`secondary-button ${resolverOpen ? "active" : ""}`}
            type="button"
            onClick={() => setResolverOpen(!resolverOpen)}
          >
            <Search size={15} /> Quick resolve
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={onOpenEvidence}
          >
            <FileText size={15} /> Resolver evidence
          </button>
        </div>
      </div>

      <div className="message-scroll">
        <div className="message-column">
          {resolverOpen && (
            <ResolverCard
              api={api}
              initialUrl={initialResolverUrl}
              onClose={() => setResolverOpen(false)}
              onApplyRole={handleUseResolvedUrl}
            />
          )}

          {messages.length === 0 && (
            <WorkspaceHero
              onPrompt={(text) => void sendMessage({ text })}
              onStartResolver={onStartResolver}
            />
          )}

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
              <div>
                <strong>Career agent blocked</strong>
                <p>{error.message}</p>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={submit}>
          <textarea
            ref={textareaRef}
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
            <button
              className="send-button"
              type="button"
              aria-label="Stop agent"
              onClick={stop}
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              aria-label="Send message"
              disabled={!input.trim()}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </form>
        <p>Jobnova pauses before private inputs and submission. You maintain full oversight.</p>
      </div>
    </div>
  );
}

function WorkspaceHero({
  onPrompt,
  onStartResolver,
}: {
  onPrompt: (text: string) => void;
  onStartResolver: (url: string) => void;
}) {
  const [urlInput, setUrlInput] = useState("");

  const handleResolverSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    onStartResolver(urlInput.trim());
  };

  return (
    <section className="workspace-hero">
      <div className="hero-identity">
        <div className="hero-mark">
          <LogoMark />
        </div>
        <h2 className="hero-title">Career and application agent</h2>
        <p className="hero-subtitle">
          Autonomous job destination resolver and ATS applicant with guarded private human approval.
        </p>
      </div>

      <div className="hero-resolver-box">
        <div className="hero-resolver-header">
          <div className="hero-resolver-title">
            <Search size={16} />
            <span>Direct LinkedIn resolver</span>
          </div>
          <span className="hero-resolver-badge">Deterministic destination check</span>
        </div>
        <form className="hero-resolver-form" onSubmit={handleResolverSubmit}>
          <input
            className="hero-resolver-input"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.linkedin.com/jobs/view/…"
            required
            aria-label="LinkedIn job URL to resolve"
          />
          <button className="hero-resolver-submit" type="submit">
            Resolve source <ArrowRight size={15} />
          </button>
        </form>
        <p className="hero-resolver-hint">
          Bypasses LinkedIn login walls and extracts the verified canonical employer or ATS destination.
        </p>
      </div>

      <div className="hero-prompts">
        <button
          type="button"
          className="prompt-card"
          onClick={() => onPrompt("Help me evaluate a role before I apply. What are key fit criteria?")}
        >
          <strong>Evaluate role requirements</strong>
          <span>Analyze seniority, stack match, and potential application hurdles.</span>
        </button>
        <button
          type="button"
          className="prompt-card"
          onClick={() => onPrompt("I have a job URL. Inspect required questions, fields, and salary inputs before filling.")}
        >
          <strong>Inspect application fields</strong>
          <span>Identify required questions, demographic checks, and custom inputs.</span>
        </button>
        <button
          type="button"
          className="prompt-card"
          onClick={() => onPrompt("Start the guided Lever application flow with synthetic candidate facts.")}
        >
          <strong>Lever application flow</strong>
          <span>Run guarded form navigation with private human approval cards.</span>
        </button>
      </div>

      <div className="hero-guarantees">
        <div className="guarantee-item">
          <ShieldCheck size={16} />
          <div>
            <strong>Guarded private facts</strong>
            <span>SSN, compensation, and contact details stay in memory and never touch model prompts.</span>
          </div>
        </div>
        <div className="guarantee-item">
          <Check size={16} />
          <div>
            <strong>Deterministic validation</strong>
            <span>TypeScript asserts verified company, role title, and HTTPS destination before navigation.</span>
          </div>
        </div>
        <div className="guarantee-item">
          <Lock size={16} />
          <div>
            <strong>Single authorized submission</strong>
            <span>Browser tools cannot submit without explicit final review and human approval.</span>
          </div>
        </div>
      </div>
    </section>
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
    (part): part is typeof part & { type: "data-activity"; data: ActivityData } =>
      part.type === "data-activity",
  );
  const latestActivities = [
    ...new Map(activities.map((part) => [part.data.toolCallId, part])).values(),
  ];

  return (
    <article className={`message-row ${message.role}`}>
      {message.role === "assistant" && (
        <div className="assistant-mark">
          <LogoMark />
        </div>
      )}
      <div className="message-content">
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return <RichText text={part.text} key={index} />;
          }
          if (part.type === "data-interaction") {
            const interaction = part.data as CareerInteraction;
            if (!responded.has(interaction.requestId)) {
              return (
                <InteractionCard
                  interaction={interaction}
                  onRespond={onRespond}
                  key={interaction.requestId}
                />
              );
            }
          }
          return null;
        })}

        {latestActivities.length > 0 && (
          <details
            className="activity-group"
            open={latestActivities.some((part) => part.data.phase === "failed")}
          >
            <summary>
              <Wrench size={15} />
              <span>Browser activity</span>
              <span className="activity-count-badge">
                {latestActivities.length} {latestActivities.length === 1 ? "action" : "actions"}
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="activity-group-content">
              {latestActivities.map((part) => (
                <div
                  className={`activity-row ${part.data.phase}`}
                  key={`${part.data.toolCallId}-${part.data.phase}`}
                >
                  {part.data.phase === "started" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : part.data.phase === "completed" ? (
                    <Check size={14} />
                  ) : (
                    <CircleAlert size={14} />
                  )}
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

function RichText({ text }: { text: string }) {
  const paragraphs = text.split("\n\n");

  return (
    <div className="message-text">
      {paragraphs.map((para, i) => {
        const trimmed = para.trim();
        if (!trimmed) return null;

        // Fenced code block
        if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
          const lines = trimmed.slice(3, -3).trim().split("\n");
          return (
            <pre key={i}>
              <code>{lines.join("\n")}</code>
            </pre>
          );
        }

        // Unordered list
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          const items = trimmed.split("\n").map((line) => line.replace(/^[-*]\s+/, ""));
          return (
            <ul key={i}>
              {items.map((item, idx) => (
                <li key={idx}>
                  <FormattedLine content={item} />
                </li>
              ))}
            </ul>
          );
        }

        // Ordered list
        if (/^\d+\.\s/.test(trimmed)) {
          const items = trimmed.split("\n").map((line) => line.replace(/^\d+\.\s+/, ""));
          return (
            <ol key={i}>
              {items.map((item, idx) => (
                <li key={idx}>
                  <FormattedLine content={item} />
                </li>
              ))}
            </ol>
          );
        }

        // Regular paragraph
        return (
          <p key={i}>
            <FormattedLine content={trimmed} />
          </p>
        );
      })}
    </div>
  );
}

function FormattedLine({ content }: { content: string }) {
  // Simple regex parser for bold, inline code, and links
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            key={match.index}
          >
            {linkMatch[1]}
          </a>
        );
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }

  return <>{parts.length > 0 ? parts : content}</>;
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
  const title =
    interaction.kind === "submission"
      ? "Confirm application submission"
      : interaction.kind === "answer_approval"
      ? "Review generated answer"
      : interaction.label;

  const submitValue = async (nextValue: string) => {
    setSending(true);
    await onRespond(interaction, nextValue);
  };

  return (
    <div className="interaction-card">
      <div className="interaction-heading">
        <div className="interaction-title-wrap">
          <ShieldCheck size={18} />
          <strong>{title}</strong>
        </div>
        <span className="interaction-security-tag">
          <Lock size={12} /> Guarded
        </span>
      </div>

      {interaction.kind === "user_input" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitValue(value);
          }}
        >
          {interaction.description && <p>{interaction.description}</p>}
          <div className="form-control-wrap" style={{ marginTop: "12px" }}>
            {interaction.options.length > 0 ? (
              <select
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
              >
                <option value="">Choose an option</option>
                {interaction.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : interaction.inputType === "boolean" ? (
              <select
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
              >
                <option value="">Choose an option</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
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
          </div>
          <button type="submit" disabled={!value || sending}>
            {sending ? "Continuing privately…" : "Continue privately"}
          </button>
        </form>
      )}

      {interaction.kind === "answer_approval" && (
        <>
          <p>
            The career agent prepared this draft answer for your review before entering it into
            the application:
          </p>
          <div className="draft-answer">{interaction.draft}</div>
          <div className="interaction-actions">
            <button
              type="button"
              disabled={sending}
              onClick={() => void submitValue("yes")}
            >
              Approve answer
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={sending}
              onClick={() => void submitValue("no")}
            >
              Reject &amp; rephrase
            </button>
          </div>
        </>
      )}

      {interaction.kind === "submission" && (
        <>
          <p>{interaction.prompt}</p>
          <div className="field-count-pill">
            <Check size={14} />
            <span className="tabular-nums">{interaction.completedFields}</span> fields completed
            and verified
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "8px" }}>
            This authorizes the single submission attempt for this role.
          </p>
          <div className="interaction-actions">
            <button
              type="button"
              disabled={sending}
              onClick={() => void submitValue("yes")}
            >
              Authorize one submission
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={sending}
              onClick={() => void submitValue("no")}
            >
              Do not submit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ResolverCard({
  api,
  initialUrl = "",
  onClose,
  onApplyRole,
}: {
  api: (path: string, options?: RequestInit) => Promise<Response>;
  initialUrl?: string;
  onClose: () => void;
  onApplyRole?: (jobTitle: string, company: string, url: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [run, setRun] = useState<RunResponse>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [screenshots, setScreenshots] = useState<string[]>([]);

  useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
    }
  }, [initialUrl]);

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
      const images = await Promise.all(
        result.screenshotUrls.map(async (screenshotUrl) => {
          const imageResponse = await api(screenshotUrl);
          return imageResponse.ok ? URL.createObjectURL(await imageResponse.blob()) : "";
        }),
      );
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
        <div className="resolver-title-group">
          <Search size={18} />
          <div>
            <strong>Quick resolve</strong>
            <span>Deterministic LinkedIn destination resolver</span>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close resolver"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      <form onSubmit={submit}>
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          placeholder="https://www.linkedin.com/jobs/view/…"
          aria-label="LinkedIn job URL"
        />
        <button type="submit" disabled={working}>
          {working ? (
            <>
              <LoaderCircle className="spin" size={16} /> Resolving…
            </>
          ) : (
            "Resolve"
          )}
        </button>
      </form>

      {error && (
        <div className="inline-error">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {run?.result?.success && (
        <div className="resolver-result">
          <Check size={20} />
          <div className="resolver-result-body">
            <strong>{run.result.jobTitle}</strong>
            <div className="resolver-result-meta">
              <span>{run.result.company}</span>
              <span>·</span>
              <span className="tabular-nums">{formatDuration(run.runtimeMs)}</span>
            </div>
            <div className="resolver-result-actions">
              <a href={run.result.externalJobUrl} target="_blank" rel="noreferrer">
                Open verified source <ExternalLink size={14} />
              </a>
              {onApplyRole && run.result.externalJobUrl && (
                <button
                  type="button"
                  className="resolver-apply-button"
                  onClick={() =>
                    onApplyRole(
                      run.result?.jobTitle || "Role",
                      run.result?.company || "Company",
                      run.result?.externalJobUrl || "",
                    )
                  }
                >
                  Apply in career agent <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {run?.result && !run.result.success && (
        <div className="inline-error">
          <CircleAlert size={16} />
          <span>
            <strong>Resolver blocked</strong>
            <br />
            {run.result.error}
          </span>
        </div>
      )}

      {screenshots.length > 0 && (
        <div className="resolver-screenshots-grid">
          {screenshots.map((source, idx) => (
            <div className="resolver-screenshot-wrap" key={source}>
              <img
                className="resolver-screenshot"
                src={source}
                alt={`Resolver browser proof ${idx + 1}`}
              />
              <div className="resolver-screenshot-caption">
                Browser evidence checkpoint #{idx + 1}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceModal({
  evaluation,
  onClose,
}: {
  evaluation: { summary: null | { correct: number; total: number }; cases: EvaluationCase[] };
  onClose: () => void;
}) {
  const total = evaluation.summary?.total ?? (evaluation.cases.length > 0 ? evaluation.cases.length : 20);
  const correct = evaluation.summary?.correct ?? evaluation.cases.filter((c) => c.correct).length;
  const hasData = evaluation.cases.length > 0 || evaluation.summary !== null;
  const accuracy = hasData && total > 0 ? `${Math.round((correct / total) * 100)}%` : "Pending";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="evidence-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="evidence-modal-header">
          <div>
            <h2 id="evidence-modal-title">Resolver evaluation evidence</h2>
            <p>
              Audit ledger of the frozen 20-case test benchmark from <code>data/evaluation.json</code>.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close evidence modal"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="kpi-strip">
          <div className="kpi-item">
            <span className="kpi-label">Benchmark set</span>
            <div className="kpi-value">{total} cases</div>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Verified correct</span>
            <div className="kpi-value">{hasData ? `${correct}/${total}` : "Pending"}</div>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Accuracy rate</span>
            <div className="kpi-value">{accuracy}</div>
          </div>
          <div className="kpi-item">
            <span className="kpi-label">Destination check</span>
            <div className="kpi-value">Guarded ATS</div>
          </div>
        </div>

        <div className="evidence-table-container">
          {evaluation.cases.length > 0 ? (
            <table className="evidence-table">
              <thead>
                <tr>
                  <th style={{ width: "80px" }}>Case</th>
                  <th>Company</th>
                  <th>Job title</th>
                  <th style={{ width: "120px" }}>Result</th>
                  <th className="text-right" style={{ width: "110px" }}>Runtime</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {evaluation.cases.map((item) => (
                  <tr key={item.case}>
                    <td className="font-mono tabular-nums">#{item.case}</td>
                    <td>
                      <strong>{item.company || "—"}</strong>
                    </td>
                    <td>{item.jobTitle || "—"}</td>
                    <td>
                      <span
                        className={`evidence-badge ${item.correct ? "pass" : "fail"}`}
                      >
                        {item.correct ? (
                          <>
                            <Check size={12} /> Verified
                          </>
                        ) : (
                          <>
                            <X size={12} /> Failed
                          </>
                        )}
                      </span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {item.runtimeMs ? `${(item.runtimeMs / 1000).toFixed(1)} s` : "—"}
                    </td>
                    <td style={{ color: "var(--text-faint)", fontSize: "12px" }}>
                      {item.failureReason || "Matched verified ATS canonical URL"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="evidence-empty-note">
              <p>
                <strong>Evaluation benchmark run is pending.</strong>
              </p>
              <p style={{ marginTop: "6px" }}>
                To populate this ledger, the owner runs the local evaluation command:
              </p>
              <p style={{ marginTop: "8px" }}>
                <code>npm run resolve</code> on the frozen 20-case set and checks results into{" "}
                <code>data/evaluation.json</code>.
              </p>
              <p style={{ marginTop: "12px", color: "var(--text-faint)", fontSize: "12.5px" }}>
                The deployed product renders the exact checked-in results rather than fabricating a score.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AccessGate({
  initialCode,
  onAccepted,
}: {
  initialCode: string;
  onAccepted: (code: string) => void;
}) {
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
        <div className="hero-mark">
          <LogoMark />
        </div>
        <h2>Welcome to Jobnova</h2>
        <p>Enter the take-home invite code to access the career agent and resolver.</p>
        <label htmlFor="invite-code">Invite code</label>
        <input
          id="invite-code"
          type="password"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoFocus
          required
          autoComplete="current-password"
          placeholder="Enter invite code"
        />
        {error && (
          <div className="inline-error">
            <CircleAlert size={16} /> <span>{error}</span>
          </div>
        )}
        <button type="submit" disabled={checking}>
          {checking ? "Verifying…" : "Continue to workspace"}
        </button>
      </form>
    </div>
  );
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      J
    </span>
  );
}

async function pollRun(
  runId: string,
  api: (path: string, options?: RequestInit) => Promise<Response>,
): Promise<RunResponse> {
  while (true) {
    const response = await api(`/api/runs/${runId}`);
    const run = (await response.json()) as RunResponse & { error?: string };
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

