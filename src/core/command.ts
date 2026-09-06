/**
 * The name the user types to run this console.
 *
 * The installed binary is `term-player`, but the zsh function that launches it
 * from source is `play`. That function exports its own name through the
 * environment, so any hint the console prints names a command that actually
 * exists rather than the binary nobody typed.
 */
export const BIN = process.env['TERM_PLAYER_BIN'] ?? 'term-player';
