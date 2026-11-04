# Third-party sources

This file records the public sources used by Cleo. Their license and notice files remain with the relevant code and references. A source credit does not imply endorsement of Cleo or its legal output.

## Desktop

- **Clicky:** [farzaa/clicky](https://github.com/farzaa/clicky/tree/e71105ce091d71dff4d89cf5d8d37ea1df460961), pinned to `e71105ce091d71dff4d89cf5d8d37ea1df460961`. MIT, copyright 2026 Farza. Cleo previously adapted `BlueCursorView.startTrackingCursor` from `OverlayWindow.swift` for a cursor tracker. That tracker and passive hover marking were subsequently removed. The public capture, audio and coordinate-handling code was also consulted during development. The [license](../desktop/ThirdParty/Clicky-LICENSE) remains in the source and app bundle.
- **Glide:** [shujanshaikh/glide](https://github.com/shujanshaikh/glide/tree/b2914f19b758b63927fcd6430fcffddeed6f171e), pinned to `b2914f19b758b63927fcd6430fcffddeed6f171e`. MIT, copyright 2026 Shujan Shaikh. Cleo's early native desktop work adapted panel lifecycle and presentation approaches from Glide. The [license](../desktop/ThirdParty/Glide-LICENSE) remains in the source and app bundle.

The current desktop starts voice explicitly. Native code handles screen capture, text recognition, playback, exact passage marks and the sketchbook. See [architecture.md](../architecture.md).

## Voice

Selected modules from [Qwen Audio Agent](https://github.com/QwenAudio/qwen-audio-agent/tree/b648b5e116822f0265a72835890606318e08d9c6), pinned to `b648b5e116822f0265a72835890606318e08d9c6`, are copied into `src/vendor/qwen-audio-agent`:

- `server/src/voice/turn-correlation.mjs`
- `server/src/voice/realtime-turn-state.mjs`
- `server/src/voice/announcement/announcement-window.mjs`

The [Apache 2.0 license](../src/vendor/qwen-audio-agent/LICENSE) and [NOTICE](../src/vendor/qwen-audio-agent/NOTICE) are retained alongside them.

`src/voice-policy.mjs` adapts guidance from upstream `config/frontend-agent/PROMPT.md` and `server/src/frontend/frontend-tools.mjs` into English for Cleo: natural speech, truthful work status, continuation, cancellation and avoiding spoken internal identifiers. Cleo adds contract-context and native presentation rules, removes unrelated tools and requires explicit voice activation. These adaptations are separate from the unchanged lifecycle modules.

The OpenAI Agents SDK comes from its npm package and is pinned by `package-lock.json`. Cleo uses its Realtime connection and audio protocol, with native microphone and speaker handling.

## Legal references, fonts and web components

The legal library's [manifest](../skills/legal/manifest.json) records its selected sources. License files, provenance notes, disclaimers and template references remain under `skills/legal/`, including the Anthropic legal workflows, General Legal templates, GRC and Mike reference collections, optional tools and Cleo's own workflows. These files are guidance and templates, not a verification of a generated document's legal accuracy.

The bundled fonts retain their [license](../src/assets/fonts/LICENSE.txt). The web message-circle component retains its [license](../web/components/ui/message-circle.LICENSE). Package dependencies retain their own terms through the installed packages and lockfile.
