# Cleo (the dream)

Most founders and small businesses cannot afford the legal help they need.

I'm a law student, and I will never in my right mind understand why getting legal help is so expensive. So I built Cleo: a persistent legal AI agent with memory.

You can text her on iMessage to get an NDA drafted, invite her to a Google Meet and ask her to walk through a contract or its redlines, or summon her on your screen and ask her to explain something you're reading. She can point to the relevant wording and sketch out an explanation while you talk.

The idea is simple: getting help should feel like having a conversation. It should be intuitive, and it shouldn't mean spending your day with your head buried in a laptop.

The larger goal is to build an AI native legal services firm. Software is part of that, but selling software isn't the end goal. I want people to get useful legal help without an enterprise login, and have the matter reach a lawyer whenever it needs one.

That's the dream. This repo is the prototype I'm building towards it. The lawyer service and routing are still to be built.

## What's here

- **iMessage:** document intake, drafting, contract review and Word files with tracked changes, through Keiki and Cleo's backend.
- **Google Meet:** attendance through Attendee, spoken explanations and walkthroughs of saved contracts, drafts and redlines. Joining, speaking and presenting have separate controls.
- **On-screen Cleo:** a native Mac companion that can read visible text, talk through it, mark exact passages and draw in a floating sketchbook.
- **Memory:** saved context for a particular user and contract, with optional Supermemory search. The desktop can connect to the same contract record used by iMessage.

These pieces need their own credentials and setup. Building the Mac app does not also set up the iMessage agent or meeting service. This is still a development project, not a finished legal service.

## Run on-screen Cleo

### 1. What you need

- A Mac running **macOS 14 or later** for screen reading.
- **Node.js 24 or later** and npm. Check `node --version` in the terminal you'll build from.
- **Xcode**, opened at least once with its setup completed, and working Swift command-line tools. Check `swift --version`.
- An **Apple Development signing identity** installed on your Mac, including its private key.
- An **OpenAI API key** with access and credit for the models configured in `src/voice-runtime.mjs` and `src/voice-review.mjs`. Voice uses the API and incurs usage charges.

The app runs from this checkout. Keep the folder, its dependencies and the Node installation in place after building it.

### 2. Get the code

```sh
git clone https://github.com/vedantdas312-cell/cleo-the-dream.git
cd cleo-the-dream
npm ci
mkdir -p .local
chmod 700 .local
```

If you've already cloned it, run the remaining commands from that folder.

### 3. Add your voice key

Create `.local/voice.env` in your editor and add:

```dotenv
OPENAI_API_KEY=your_openai_api_key
```

Then restrict access to the file:

```sh
chmod 600 .local/voice.env
```

Use your actual key in that local file only. `.local/` is ignored by Git. The desktop reads this file directly; putting the key in `.env` or only exporting it in your terminal won't configure the app.

### 4. Configure signing

If you need an identity, use Xcode's account settings to manage your certificates and create an Apple Development certificate. Apple's [signing certificate guide](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html) covers this step.

List the signing identities available on your Mac:

```sh
security find-identity -v -p codesigning
```

Create `.local/desktop-signing.json`, using the hash shown next to your Apple Development identity:

```json
{
  "identity": "YOUR_APPLE_DEVELOPMENT_IDENTITY_HASH"
}
```

Keep an existing signing configuration if you've already built Cleo. The build requires a stable identity and will stop if it is missing or would change the installed app's signing identity.

### 5. Build and open

```sh
npm run desktop:dev
```

This builds the sketchbook and native app, signs it, installs it at `output/Cleo.app`, and opens it. For later launches:

```sh
npm run desktop:launch
```

Opening Cleo shows the companion. It does not start the microphone.

### 6. Talk to her

1. Open a document and leave the passage you want to discuss visible. Put your pointer over it.
2. Press **Control-C** to start a voice session, or choose **Start / pause Cleo** from the sparkle icon in the Mac menu bar.
3. Allow microphone access when prompted. For screen reading, enable Cleo under **System Settings → Privacy & Security → Screen Recording**. The label can include “System Audio” on newer macOS versions. Reopen Cleo if macOS asks you to.
4. Ask something concrete: “Explain this termination clause,” “What does thirty days' notice mean here?” or “Can you sketch how this works?”
5. Press **Control-C** again to stop the session. You can quit Cleo from the menu bar.

While a voice session is active, audio and recognized screen text are sent to OpenAI. Screen images are processed locally. The sketchbook keeps completed drawings during the running app session; it isn't a saved notebook across restarts.

### Optional: connect the same contract memory as iMessage

Screen explanations work without this. To connect an existing Cleo backend, its operator must configure a separate desktop token bound to your user. Put only that token and the backend origin in `.local/context.env`:

```dotenv
CLEO_CONTEXT_URL=https://your-cleo-backend.example
CLEO_DESKTOP_TOKEN=your_dedicated_desktop_pairing_token
```

The token must be at least 32 characters and match the backend configuration. Restrict the file with `chmod 600 .local/context.env`, then start a new voice session. Don't use a Keiki or other provider's master API key here.

Cleo can then list your imported contracts and open the one you identify. For automatic recognition of a supported browser's Google Doc, enable Cleo under **Privacy & Security → Accessibility**. Without that permission, explicitly identify the Doc link or contract. A matching sentence on screen isn't enough to select a private contract record.

Requested wording changes are limited to verified Google review copies belonging to the paired user. They are saved as suggestions, not accepted changes. The desktop doesn't edit arbitrary files on your Mac.

For a separate local backend, see the [local context setup](docs/cleo-shared-memory.md#local-setup). Its test identity is separate from the hosted iMessage account, and `local:setup` replaces your local desktop pairing file, so don't run it over a hosted pairing you want to keep.

### If something doesn't work

- **No voice:** check `.local/voice.env`, your API account's access and credit, and microphone permission.
- **Can't read the screen:** check Screen Recording permission, use macOS 14+, and keep the document visible under the pointer.
- **Control-C is unavailable:** use the menu-bar action. Another app may already own the shortcut.
- **Signing fails:** check that the configured identity appears in `security find-identity` and has its private key. The build deliberately has no ad-hoc signing fallback.
- **You moved the checkout or changed Node:** rebuild with `npm run desktop:dev`; the app records those paths when it is built.

`npm run desktop:permissions` checks the installed app's existing microphone and screen grants by briefly capturing both locally. It stops the running app, saves a status report without the captured content, and exits. Run `npm run desktop:launch` afterwards.

For how the pieces fit together, see [architecture.md](architecture.md).

## Credits

Cleo has used code from Farza’s public [Clicky repository](https://github.com/farzaa/clicky), under its MIT license. The [Clicky license](desktop/ThirdParty/Clicky-LICENSE) is retained. The original cursor-tracking adaptation has since been retired.

The desktop also includes work adapted from [Glide](https://github.com/shujanshaikh/glide), with its [MIT license](desktop/ThirdParty/Glide-LICENSE). Voice turn handling uses selected [Qwen Audio Agent](https://github.com/QwenAudio/qwen-audio-agent) modules with their [Apache 2.0 license](src/vendor/qwen-audio-agent/LICENSE) and [notice](src/vendor/qwen-audio-agent/NOTICE).

Legal references and templates retain their own licenses and provenance under `skills/legal/`. See [third-party sources](docs/third-party-sources.md) for the source details.
