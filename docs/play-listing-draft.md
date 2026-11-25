# Play Store Listing Draft — Agents Chat (v0.4.0-ls.1)

> **Status: DRAFT — awaiting Harry's signature before anything touches Play Console.**
> Pattern: Angus Tasks listing (max-caution data-safety doctrine, self-hosted framing).
> The app is live on the internal track; production listing is the next Console step.

---

## App Name

Agents Chat

## Short Description (80 chars max)

Chat with your AI agents on your own server or cloud, from your phone.

## Full Description

Agents Chat is a mobile client for [Letta](https://letta.com) AI agents.
Connect to your own Letta server or cloud account, then chat with your
agents, follow their work, and approve their actions — from anywhere.

**Core features**

- **Chat with your agents** — full conversation view with tool activity,
  reasoning, and file attachments
- **Approvals on the go** — when an agent needs permission mid-run, it
  asks right in the app
- **Background notifications** — get notified when a run finishes, even
  with the app closed
- **Multiple servers** — connect to your self-hosted Letta servers or
  the Letta cloud, switch profiles freely
- **Pinned conversations** and unread indicators for the threads that
  matter
- **Choose the model and reasoning effort** per conversation

**Bring your own agent**

This app is a client. Your agents run on infrastructure you control:
your own Letta server (self-hosted, open source) or your Letta cloud
account. The app talks directly to your server — the developer operates no
messaging or data backend and sees none of your conversations.

**Self-hosting**

Run your own Letta server and connect from the app. Guide and source:
[letta.com](https://letta.com) / [github.com/letta-ai](https://github.com/letta-ai)

---

## Category

**Productivity** (DECIDED Nov 25: agent tooling/work surface, not person-to-person messaging)

---

## Data Safety Answers (Play Console form)

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** (max-caution) |
| Data type collected | **App activity → App interactions** |
| Is data collected? | Yes |
| Is data shared? | No |
| Encrypted in transit? | Yes — cloud connections always TLS; self-hosted uses the scheme the user configures (wss:// recommended, plain ws:// warned) |
| Can data be deleted? | Yes — delete the conversation/account in the app or on your server |

**Rationale (for Harry's review):**

- All conversation data lives on the **user's own** Letta server or
  cloud account. The app is a pure client: no developer backend, no
  analytics, no crash-reporting SDK, no ads, no developer-visible data.
- Connections go only to the server URL/API key the user enters.
- **Why declare "App interactions — collected, not shared" (max caution):**
  the app makes network requests to the user's own server (fetching
  conversations, sending messages, polling run status). Technically the
  traffic is user-to-user's-own-server, but it is app-network-interaction
  leaving the device — we declare it rather than argue about it
  (same doctrine as Tasks/ASA, Harry's Sep 30 ruling).
- **API keys / OAuth tokens** are stored in Android Keystore-backed
  secure storage on-device, never uploaded anywhere by the app.

---

## Content Rating

- Questionnaire: utility/productivity, no user-generated content sharing
  (agent conversations are private to the user's own server), no violence
  etc. → expect **Everyone** rating.
- **UGC flag: No** (DECIDED Nov 25: private client-server traffic with the
  user's own AI agents, not person-to-person sharing)

---

## Privacy Policy URL

**DECIDED + LIVE (Nov 25):** https://legal.angussoftware.com/privacy-agents-chat/
— real static page on the established release channel (matches the
/fuel/privacy URL pattern; content follows the data-safety answers).

---

## Screenshots / Graphic Assets (needed for production)

- Phone screenshots (min 4): agent list, chat view with tool activity,
  approval prompt, model/effort picker
- Feature graphic (1024×500)
- App icon: already in-repo (assets/images/icon.png — the teal brandMark)

---

## Contact Details (Play Console)

**angussoftware.com website as public contact**; developer email: use the
Play Console account's existing address (the same one the other fleet
apps list).

---

## What's New (v0.4.0-ls.1 release notes)

- Initial public release: chat with your Letta AI agents from your phone
- Approvals, background notifications, attachments, pinned conversations
- Connect to self-hosted servers or Letta cloud
