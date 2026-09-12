/**
 * Agent profile system: allows Henry and other profiles (Kelly, etc.) to share
 * the same core architecture while maintaining isolated configurations and
 * service compositions.
 */

export type AgentProfileId = "henry" | "kelly";

export interface AgentProfile {
  id: AgentProfileId;
  name: string;
  description: string;
  /** Prefix for environment variables (e.g., "HENRY_", "KELLY_") */
  envPrefix: string;
  /** Services that this profile MUST NOT load */
  excludedServices: Set<string>;
}

const PROFILES: Record<AgentProfileId, AgentProfile> = {
  henry: {
    id: "henry",
    name: "Henry",
    description: "Local-first personal engineering and project-management agent",
    envPrefix: "HENRY_",
    excludedServices: new Set(),
  },
  kelly: {
    id: "kelly",
    name: "Kelly",
    description: "Electrical-shop quotation assistant",
    envPrefix: "KELLY_",
    excludedServices: new Set([
      "gmail",
      "jobs",
      "cover",
      "tailor",
      "resumeEditor",
      "draftReplies",
      "meetings",
      "screenshots",
      "social",
      "linkedin",
      "xBrowser",
      "mailwatch",
      "launch",
      "standup",
      "standupPoller",
    ]),
  },
};

/** Global profile instance — set once at startup before any imports. */
let activeProfile: AgentProfile = PROFILES.henry;

/**
 * Set the active profile. Must be called before any services are initialized.
 * Typically called from bin/kelly.mjs or bin/henry.mjs before importing cli.ts.
 */
export function setActiveProfile(profileId: AgentProfileId): void {
  if (!(profileId in PROFILES)) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  activeProfile = PROFILES[profileId];
}

/**
 * Get the currently active profile.
 */
export function getActiveProfile(): AgentProfile {
  return activeProfile;
}

/**
 * Check if a service is excluded for the current profile.
 */
export function isServiceExcluded(serviceName: string): boolean {
  return activeProfile.excludedServices.has(serviceName);
}
