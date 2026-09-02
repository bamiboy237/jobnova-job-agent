import { afterEach, describe, expect, it } from "vitest";
import { getResolverModelConfig } from "../src/mastra/model.js";
import { compactSupersededSnapshots } from "../src/mastra/compactSnapshots.js";
import {
  bestCandidate,
  cleanIdentity,
  isLinkedInAuthUrl,
  readObservedUrls,
} from "../src/resolver/directResolver.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Mastra resolver architecture", () => {
  it("removes obsolete snapshot payloads while preserving the latest refs and other messages", () => {
    const snapshot = (value: string) => ({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: `snapshot-${value}`,
        toolName: "browser_snapshot",
        output: { success: true, snapshot: value },
      }],
    });
    const user = {
      role: "user",
      content: "candidate profile",
    };
    const currentSnapshot = snapshot("current refs");
    const inspection = (value: string) => ({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: `inspection-${value}`,
        toolName: "inspect_current_page",
        output: { controls: [value] },
      }],
    });
    const currentInspection = inspection("current controls");
    const compacted = compactSupersededSnapshots([snapshot("old refs"), inspection("old controls"), user, currentSnapshot, currentInspection]);

    expect(compacted[0].content[0]).toMatchObject({ output: { superseded: true } });
    expect(compacted[1].content[0]).toMatchObject({ output: { superseded: true } });
    expect(compacted[2]).toEqual(user);
    expect(compacted[3]).toEqual(currentSnapshot);
    expect(compacted[4]).toEqual(currentInspection);
  });

  it("requires the final semantic candidate to match a browser-observed URL", () => {
    expect(bestCandidate("", [
      "https://careers.example.com/",
      "https://ats.example.com/jobs/req-123",
    ])).toBeUndefined();
  });

  it("collects external destinations opened in popup tabs", () => {
    expect(readObservedUrls({
      success: true,
      tabs: [
        { index: 0, url: "https://www.linkedin.com/jobs/view/123" },
        { index: 1, url: "https://jobs.example.com/roles/req-123" },
      ],
    })).toEqual([
      "https://www.linkedin.com/jobs/view/123",
      "https://jobs.example.com/roles/req-123",
    ]);
  });

  it("does not accept a model candidate that the browser never observed", () => {
    expect(bestCandidate("https://invented.example/jobs/999", [
      "https://jobs.example.com/roles/req-123",
    ])).toBeUndefined();
    expect(bestCandidate("https://invented.example/jobs/999", [])).toBeUndefined();
  });

  it("classifies LinkedIn authentication destinations without blocking public job URLs", () => {
    expect(isLinkedInAuthUrl("https://www.linkedin.com/signup/cold-join?sessionRedirect=%2Fjobs%2Fview%2F123")).toBe(true);
    expect(isLinkedInAuthUrl("https://www.linkedin.com/checkpoint/challenge/abc")).toBe(true);
    expect(isLinkedInAuthUrl("https://www.linkedin.com/jobs/view/123")).toBe(false);
    expect(isLinkedInAuthUrl("https://jobs.example.com/login")).toBe(false);
  });

  it("rejects placeholder identities before destination validation", () => {
    for (const value of ["Unknown", " "]) expect(cleanIdentity(value)).toBeUndefined();
    expect(cleanIdentity("Salesforce")).toBe("Salesforce");
  });
});

describe("Mastra model selection", () => {
  it("supports explicit OpenAI Luna selection", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "openai-key";
    const config = getResolverModelConfig();
    expect(config.agentModel.id).toBe("openai/gpt-5.6-luna");
    expect(config.browserModel).toMatchObject({ modelName: "openai/gpt-5.6-luna", reasoningEffort: "medium" });
    expect(config.agentProviderOptions).toEqual({ openai: { reasoningEffort: "medium" } });
  });

  it("uses Gemini 3.7 Flash by default and supports explicit DeepSeek selection", () => {
    delete process.env.LLM_PROVIDER;
    process.env.GEMINI_API_KEY = "gemini-key";
    expect(getResolverModelConfig()).toMatchObject({
      agentModel: { id: "google/gemini-3.7-flash" },
      browserModel: { modelName: "google/gemini-3.7-flash" },
      agentProviderOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    });

    process.env.LLM_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    expect(getResolverModelConfig().agentModel.id).toBe("deepseek/deepseek-v4-flash-vision-exp");
  });
});
