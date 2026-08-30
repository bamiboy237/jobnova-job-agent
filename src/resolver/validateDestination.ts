export interface DestinationSemanticEvaluation {
  pageType: "job" | "careers" | "homepage" | "other";
  companyMatches: boolean;
  jobMatches: boolean;
  companyEvidence: string;
  jobEvidence: string;
}

export interface ValidationContext {
  company: string;
  jobTitle: string;
  destinationUrl: string;
  semanticEvaluation?: DestinationSemanticEvaluation;
}

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  evidence?: {
    companyEvidence: string;
    jobEvidence: string;
  };
}

/**
 * Validates whether the resolved destination page represents the exact company and role.
 * Success requires non-LinkedIn HTTPS URL, pageType === 'job',
 * companyMatches === true, jobMatches === true, and non-empty evidence.
 */
export function validateDestination(context: ValidationContext): ValidationResult {
  const {
    company,
    jobTitle,
    destinationUrl,
    semanticEvaluation,
  } = context;

  if (!destinationUrl) {
    return { isValid: false, reason: "Destination URL is empty" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(destinationUrl);
  } catch {
    return { isValid: false, reason: `Destination URL "${destinationUrl}" is not a valid URL` };
  }

  if (parsedUrl.protocol !== "https:") {
    return { isValid: false, reason: `Destination URL "${destinationUrl}" is not HTTPS` };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  const fullUrlLower = destinationUrl.toLowerCase();

  // 1. Strictly reject all LinkedIn authentication, registration, and on-site destinations
  if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
    if (
      pathname.includes("/signup") ||
      pathname.includes("/login") ||
      pathname.includes("/authwall") ||
      pathname.includes("/checkpoint") ||
      pathname.includes("/cold-join") ||
      pathname.includes("/challenge") ||
      pathname.includes("/verification") ||
      fullUrlLower.includes("auth") ||
      fullUrlLower.includes("sign-in")
    ) {
      return {
        isValid: false,
        reason: `Destination is a LinkedIn authentication/registration gate: ${destinationUrl}`,
      };
    }
    return {
      isValid: false,
      reason: `Destination is still on LinkedIn (${destinationUrl}) instead of an external job source`,
    };
  }

  // 2. Validate non-empty identity inputs
  const cleanCompany = (company || "").trim();
  const cleanJobTitle = (jobTitle || "").trim();

  if (!cleanCompany) {
    return { isValid: false, reason: "Extracted company name is missing or empty" };
  }
  if (!cleanJobTitle) {
    return { isValid: false, reason: "Extracted job title is missing or empty" };
  }

  if (!semanticEvaluation) {
    return { isValid: false, reason: "Destination semantic validation did not return evidence" };
  }

  const { pageType, companyMatches, jobMatches, companyEvidence, jobEvidence } = semanticEvaluation;

  // 3. Reject generic careers pages, homepages, or category pages
  if (pageType !== "job") {
    return {
      isValid: false,
      reason: `Destination page is a generic ${pageType} page rather than a dedicated job opening`,
    };
  }

  if (!companyMatches || !companyEvidence?.trim()) {
    return {
      isValid: false,
      reason: `Destination page does not match company "${company}". Evidence: "${companyEvidence || 'None'}"`,
    };
  }

  if (!jobMatches || !jobEvidence?.trim()) {
    return {
      isValid: false,
      reason: `Destination page does not match role "${jobTitle}". Evidence: "${jobEvidence || 'None'}"`,
    };
  }

  return {
    isValid: true,
    evidence: {
      companyEvidence: companyEvidence.trim(),
      jobEvidence: jobEvidence.trim(),
    },
  };
}
