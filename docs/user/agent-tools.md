# SSHCode tools

Open **Settings > Skills & tools** on web or desktop. On mobile, open **Settings** and find **Tools** under **Agents & models**. Choose the environment whose tools you want to manage; these are environment settings, not project overrides.

All SSHCode-provided tools, including browser tools, are enabled by default. Use search to find a tool by its name, description, or group.
Choose **All providers** to edit global defaults, or select a provider to customize just its tools.
The **Tool groups** controls switch related tools, such as Browser, together in the selected scope.

## Global defaults and provider overrides

Global switches set the default for every provider. A provider can then override a tool without changing the other providers. Each provider row explains whether its value is custom or inherited.

- **Enable all** or **Disable all** under Global defaults replaces the whole tool policy and clears every provider override.
- **Enable all** or **Disable all** for one provider replaces that provider's default and clears its individual tool choices.
- **Reset to global** removes a provider's default and individual choices, so it inherits the global settings again.

These controls only affect tools supplied by SSHCode. Provider-native CLI tools and external plugin tools keep their existing behavior. Native Claude RC Terminal sessions are unchanged and receive no MCP tooling from this feature.

An older environment shows an update prompt instead of tool controls. Read-only connections can inspect settings but cannot save changes.

## X posts and X search

Every agent can read an X post from its link (`read_x_post`) and search X (`search_x`). Agents are told to search X on their own, the way they use web search, for news, launches, reactions and anything recent; you do not have to ask for it. Reading needs no account or key.

Search uses whichever of these you have:

- **X API key (fast).** Save an X API Bearer Token for **All sessions** under the name `X_API_BEARER_TOKEN` in [API keys](api-keys.md). A search takes about a second. X bills each returned post, up to 10 per search, and this search covers the last 7 days.
- **Grok Build (no key).** With Grok switched on and signed in, searches run on your Grok account and take from 10 seconds to a minute or more. SSHCode also uses Grok when the X API refuses a query or finds nothing.

A Grok search runs in Grok's strict sandbox from an empty folder with web fetch off. It cannot read your files, and SSHCode refuses any command or file request it makes.

## Model family rankings

Open **Settings > Model family rankings** on web, desktop, or mobile and choose a task category. Available families appear automatically with a current model. Place families in tiers from **S** to **F**. Drag them between tiers and left or right on web, or use a family's menu on any client. On mobile, tap a family to open its menu. Agents prefer higher tiers, then earlier families within a tier; **Unranked** families are never recommendations. New releases inherit their family's rank.

Changes save automatically to the selected environment and appear on its other connected clients. **Reset** clears the selected category's preferences. Use **Add category** for a custom task. **Show all families** reveals unavailable and internal families; their saved preferences are kept, and unavailable choices are skipped during lookup. A saved family's menu also lets you edit an optional note of up to 500 characters. Agents receive a short excerpt with each recommendation. Existing tiers and notes still load. Previously ordered rankings appear in S in their saved order (after F choices if the category already had tiers).

Agents can read a few relevant preferences through the Models tool group. They cannot edit your tiers or thumbs, but may grade their own finished subagent tasks. An explicit model request takes priority, and agents still check current availability, quota, and replacement models before delegating. Rankings start empty and never trigger paid evaluations.

**From your runs** shows each model's subagent results from the last 60 days, with **few runs** below three. Hover on web or tap on mobile for the breakdown by task kind. Rate a finished subagent with a thumb; choose the same thumb again to clear it. Your thumbs carry more weight than parent-agent grades. This evidence never changes your tiers or removes a model.

Only run metadata and ratings are recorded, never prompts or results.
