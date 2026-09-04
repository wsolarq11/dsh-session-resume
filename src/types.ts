/**
 * Public type-only subpath for Remote boundary types consumed by the client
 * half (typert.remote-client) and the dsh-typert-generator's model.
 */
export type { RemoteResolveResult, RemoteCompleteResult } from './host/session-resume-service.js'
export type { ResumePlan, ResumePlanOk, ResumeSourceInfo, ResumeTarget } from './shared/plan.js'
export type { ResumeConfig } from './host/config.js'
export type { StoredSnapshot } from './host/snapshot-store.js'
export type { SessionLogPathResult, SessionInfo } from './host/session-log.js'
