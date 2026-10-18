# terminal-web shell integration for PowerShell panes under psmux.
#
# psmux reads a pane's directory (#{pane_current_path}) from the process, but
# PowerShell's `cd` only moves PowerShell's own location and leaves the process
# directory where pwsh started. Every prompt re-aligns the two, so the session
# list, new tabs and splits, and the file browser follow `cd` as they do on
# Linux. The user's own prompt (profile, oh-my-posh, ...) is kept and wrapped.
#
# Dot-sourced by src/tmux.ts after the profile has loaded.

$global:__twPrompt = $function:prompt
function global:prompt {
  try {
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
      [System.IO.Directory]::SetCurrentDirectory($loc.ProviderPath)
    }
  } catch {}
  if ($global:__twPrompt) { & $global:__twPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}
