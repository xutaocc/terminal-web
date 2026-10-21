// The server side of the terminal-web opencode plugin does nothing: the pane is
// only knowable from the TUI (see tui.js). opencode still asks for a package
// entrypoint when the plugin directory is picked up by its global plugin
// discovery, so re-export the same module instead of duplicating it.
export { default } from './tui.js';
