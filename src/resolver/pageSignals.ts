import { type Page } from "playwright-core";

export interface PageLink {
  url: string;
  text: string;
}

export interface LinkedInListingSignals {
  company: string;
  jobTitle: string;
  location: string;
  companyProfileUrl: string;
  externalApplyUrl: string;
  easyApplyVisible: boolean;
}

export interface EmbeddedJobEvidence {
  heading: string;
  text: string;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toHttpsUrl(rawUrl: string, baseUrl: string): string {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function comparableUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export function resolveExternalApplyUrl(rawValue: string, baseUrl: string): string {
  const urlMatch = rawValue.match(/https?:\/\/[^\s"'<>]+/i)?.[0] || rawValue.trim();
  const candidate = toHttpsUrl(urlMatch, baseUrl);
  if (!candidate) return "";

  const parsed = new URL(candidate);
  const isLinkedIn = parsed.hostname === "linkedin.com" || parsed.hostname.endsWith(".linkedin.com");
  if (isLinkedIn && parsed.pathname.includes("/externalApply/")) {
    const target = parsed.searchParams.get("url");
    return target ? toHttpsUrl(target, baseUrl) : "";
  }
  return isLinkedIn ? "" : candidate;
}

export function selectCareersUrl(links: PageLink[], currentUrl: string): string {
  const scored = links.flatMap((link) => {
    const url = toHttpsUrl(link.url, currentUrl);
    if (!url) return [];
    if (comparableUrl(url) === comparableUrl(currentUrl)) return [];
    const text = normalizeText(link.text);
    const path = normalizeText(new URL(url).pathname);
    let score = 0;
    if (/^(careers?|jobs?|open positions?|join (us|our team)|work with us)$/.test(text)) score += 4;
    if (/\b(careers?|jobs?|open positions?)\b/.test(text)) score += 2;
    if (/\b(careers?|jobs?|openings?|positions?)\b/.test(path)) score += 1;
    return score > 0 ? [{ url, comparable: comparableUrl(url), score }] : [];
  });

  scored.sort((a, b) => b.score - a.score);
  if (!scored[0] || scored[0].score < 3) return "";
  const best = scored.filter((item) => item.score === scored[0].score);
  const comparableUrls = [...new Set(best.map((item) => item.comparable))];
  return comparableUrls.length === 1 ? best[0].url : "";
}

export function selectExactJobUrl(links: PageLink[], jobTitle: string, currentUrl: string): string {
  const expected = normalizeText(jobTitle);
  if (!expected) return "";

  const matches = links.flatMap((link) => {
    const url = toHttpsUrl(link.url, currentUrl);
    if (!url) return [];
    const text = normalizeText(link.text);
    const exact = text === expected;
    const supportedSuffix = text.startsWith(`${expected} `)
      && /^(apply|view|details|learn more)( now)?$/.test(text.slice(expected.length + 1));
    return exact || supportedSuffix ? [url] : [];
  });

  const uniqueMatches = [...new Set(matches)];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : "";
}

export async function readLinkedInListingSignals(page: Page): Promise<LinkedInListingSignals> {
  const raw = await page.evaluate(() => {
    const jobPostings: Array<Record<string, any>> = [];
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))) {
      try {
        const pending: any[] = [JSON.parse(script.textContent || "")];
        while (pending.length > 0) {
          const value = pending.pop();
          if (!value) continue;
          if (Array.isArray(value)) {
            pending.push(...value);
            continue;
          }
          if (typeof value !== "object") continue;
          const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
          if (types.includes("JobPosting")) jobPostings.push(value);
          if (value["@graph"]) pending.push(value["@graph"]);
        }
      } catch {
        // Ignore malformed structured data and continue with visible DOM evidence.
      }
    }

    const listingId = window.location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || "";
    const matchingPosting: Record<string, any> | undefined = listingId
      ? jobPostings.find((candidate) => {
          const identifier = candidate.identifier;
          const identityValues = [
            candidate.url,
            candidate["@id"],
            typeof identifier === "object" ? identifier?.value : identifier,
          ];
          return identityValues.some((value) => typeof value === "string" && value.includes(listingId));
        })
      : undefined;
    const posting: Record<string, any> = matchingPosting || (jobPostings.length === 1 ? jobPostings[0] : {});
    const organization = posting.hiringOrganization || {};
    const jobLocation = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
    const address = jobLocation?.address || {};
    const locationText = [address.addressLocality, address.addressRegion, address.addressCountry]
      .filter(Boolean)
      .join(", ");
    let companyDomText = "";
    for (const selector of [
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name",
      "[class*='top-card-layout__card'] [class*='company']",
    ]) {
      companyDomText ||= document.querySelector(selector)?.textContent?.trim() || "";
    }
    let jobTitleDomText = "";
    for (const selector of ["h1", "[class*='job-title']"]) {
      jobTitleDomText ||= document.querySelector(selector)?.textContent?.trim() || "";
    }
    let locationDomText = "";
    for (const selector of [
      ".job-details-jobs-unified-top-card__primary-description-container",
      "[class*='job-details-jobs-unified-top-card__bullet']",
      "[class*='topcard__flavor--bullet']",
    ]) {
      locationDomText ||= document.querySelector(selector)?.textContent?.trim() || "";
    }

    const companyName = typeof organization.name === "string" ? organization.name : companyDomText;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
    const externalApplyValues = [
      ...Array.from(document.querySelectorAll<HTMLElement>("code#applyUrl, [data-apply-url]"))
        .map((element) => element.textContent || element.getAttribute("data-apply-url") || ""),
      ...links
        .filter((link) => link.href.includes("/jobs/view/externalApply/") || (
          /apply on company website|company website/i.test(link.textContent || "")
          && !link.href.includes("/jobs/view/")
        ))
        .map((link) => link.href),
    ];
    const normalizedCompany = companyName.toLowerCase();
    const companyProfileUrl = links.find((link) => {
      if (!link.href.includes("/company/")) return false;
      const evidence = `${link.textContent || ""} ${link.getAttribute("aria-label") || ""}`.toLowerCase();
      const visibleEvidence = evidence.trim();
      return Boolean(visibleEvidence && normalizedCompany && (
        visibleEvidence.includes(normalizedCompany) || normalizedCompany.includes(visibleEvidence)
      ));
    })?.href || "";
    const easyApplyVisible = links.some((link) => /easy apply/i.test(link.textContent || link.getAttribute("aria-label") || ""))
      || Array.from(document.querySelectorAll("button")).some((button) => /easy apply/i.test(button.textContent || button.getAttribute("aria-label") || ""));

    return {
      company: companyName,
      jobTitle: typeof posting.title === "string" ? posting.title : jobTitleDomText,
      location: String(locationText || locationDomText),
      companyProfileUrl,
      externalApplyValues,
      easyApplyVisible,
    };
  });

  const externalApplyUrl = raw.externalApplyValues
    .map((value: string) => resolveExternalApplyUrl(value, page.url()))
    .find(Boolean) || "";

  return {
    company: raw.company.trim(),
    jobTitle: raw.jobTitle.trim(),
    location: raw.location.trim(),
    companyProfileUrl: toHttpsUrl(raw.companyProfileUrl, page.url()),
    externalApplyUrl,
    easyApplyVisible: raw.easyApplyVisible,
  };
}

export async function readPageLinks(page: Page): Promise<PageLink[]> {
  const frameLinks = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => {
        const currentHeading = document.querySelector("h1")?.textContent?.trim() || "";
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .slice(0, 400)
          .map((link) => ({
            url: link.href,
            text: (
              link.querySelector("h1, h2, h3, h4")?.textContent
              || link.getAttribute("aria-label")
              || link.textContent
              || link.getAttribute("title")
              || ""
            ).trim(),
          }))
          .filter((link) => link.text && link.url);
        if (currentHeading && location.href.startsWith("https://")) {
          links.unshift({ url: location.href, text: currentHeading });
        }
        return links;
      });
    } catch {
      return [];
    }
  }));
  return frameLinks.flat();
}

export async function readEmbeddedJobEvidence(
  page: Page,
  jobTitle: string,
  timeoutMs = 8000,
): Promise<EmbeddedJobEvidence | null> {
  const expected = normalizeText(jobTitle);
  const deadline = Date.now() + timeoutMs;

  do {
    for (const frame of page.frames()) {
      try {
        const headings = await frame.locator("h1, h2").allTextContents();
        const heading = headings.find((value) => normalizeText(value) === expected)?.trim();
        if (!heading) continue;
        const text = (await frame.locator("body").innerText({ timeout: 1500 })).trim().slice(0, 4000);
        return { heading, text };
      } catch {
        // The frame can detach while the embedded application is loading.
      }
    }
    if (Date.now() < deadline) await page.waitForTimeout(250);
  } while (Date.now() < deadline);

  return null;
}
