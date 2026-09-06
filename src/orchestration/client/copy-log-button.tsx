/**
 * Re-export of the header "复制日志地址" button. The canonical implementation
 * lives in `copy-log-button.ts`; this .tsx view exists only to honor a
 * component extension point that some hosts resolve through a JSX-capable
 * entry. It carries no JSX itself, so no `jsx` compiler flag is required.
 */
export * from './copy-log-button.js'