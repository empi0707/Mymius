import { TerminalRouter } from './router'

/** One router for the whole window: it owns the two global event subscriptions. */
export const router = new TerminalRouter(window.mymius.terminal)
