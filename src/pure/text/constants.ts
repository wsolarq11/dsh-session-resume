/** Shared limits that must stay in sync with the official session-reference service. */
export const MAX_REFERENCES = 3
export const MAX_SOURCE_SESSIONS = MAX_REFERENCES

/** One prompt shape used by every resume entry point, so URL/path flows agree. */
export const RESUME_INSTRUCTION =
  '请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。'
