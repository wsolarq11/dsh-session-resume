/**
 * Public type-only subpath for Remote boundary types consumed by the client
 * half (typert.remote-client) and the dsh-typert-generator's model.
 */
export type { RemoteResolveResult, RemoteCompleteResult } from './orchestration/host/session-resume-service.js'
export type { ResumePlan, ResumePlanOk, ResumeSourceInfo, ResumeTarget } from './pure/plan/plan.js'
export type { ResumeConfig } from './io/fs/config.js'
export type { StoredSnapshot } from './io/fs/snapshot-store.js'
export type { SessionLogPathResult, SessionInfo } from './io/fs/session-log.js'
