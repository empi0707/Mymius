/**
 * Compile-time guard: the UI-facing types in shared/ipc.ts are copies (the renderer must not import
 * Node-only packages). This file fails to compile if they drift from the real ones.
 */
import type { HostInput as VHostInput, HostSummary as VHostSummary, KeySummary as VKeySummary } from '@mymius/vault'
import type { HostInput, HostSummary, KeySummary } from '../shared/ipc'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const _summary: Same<VHostSummary, HostSummary> = true
export const _input: Same<VHostInput, HostInput> = true
export const _key: Same<VKeySummary, KeySummary> = true
