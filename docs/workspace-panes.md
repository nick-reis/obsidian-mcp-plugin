# Workspace pane management (local extension)

The workspace tool lists the main Obsidian workspace tabs and manages Markdown
exercise panes. Enable the desired actions individually in the plugin settings
under Tool visibility → workspace (open, split, focus and close are opt-in).
Read-only mode must be off for pane changes.

1. Call workspace with action list. Identify the ChatGPT web viewer using
   origin https://chatgpt.com when available, or ask the user to identify its
   leaf. IDs are opaque and valid only until the plugin reloads or leaf closes.
2. Create an exercise with vault.create.
3. Call workspace with action open, path set to the exercise note, anchorId set
   to the chat leaf ID, direction right, and focus false.
4. Save the returned leafId. Reuse it with action open, path and leafId (omit
   anchorId). Do not reuse the chat leaf.
5. Read the completed note via vault.read after the user's edits have saved.
6. Call workspace with action close and the exercise leafId when finished.
   This does not delete the note.

Only unchanged, unpinned MCP-created panes can be replaced or closed. If a
user repurposes a pane, the plugin refuses the operation. A plugin restart
forgets pane ownership; close leftover panes manually. No arbitrary commands,
web page contents, full chat URLs or sidebar controls are exposed.

inspect returns the same leaf and tab-group IDs as list (not a full layout
tree). The active field represents the most recent main-workspace leaf.
Native Markdown editing is supported; a dedicated source-code editor is not
included. This extension requires the normal Obsidian minimum app version.
