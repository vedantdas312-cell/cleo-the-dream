# Shared contract context

Cleo stores context under a particular user and contract. Desktop voice can connect to the same backend as iMessage using a separate pairing token. Optional Supermemory indexing adds semantic search; the SQLite conversation record remains available without it.

## Local setup

Use Node 24 or later and install dependencies with `npm ci`.

```sh
npm run local:setup
```

This creates backend credentials and a desktop pairing under ignored `.local/`. The backend uses SQLite, binds to `127.0.0.1`, and uses the fixture identity `local-tester`. It is separate from a hosted iMessage account. The command replaces `.local/context.env`, so preserve an existing hosted pairing before running it.

`start:local` also loads `.local/supermemory.env`. Create that file in your editor, even if you leave the key empty:

```dotenv
SUPERMEMORY_API_KEY=
```

Restrict access and start the backend:

```sh
chmod 600 .local/supermemory.env
npm run start:local
```

An empty key disables semantic indexing but keeps local persistence. Adding your own key enables indexing of selected recorded messages. The loopback backend cannot receive webhooks from Keiki's cloud service.

In another terminal, import a local Word document:

```sh
npm run local:contract -- import .local/example.docx
```

Use the returned source ID for subsequent commands:

```sh
npm run local:contract -- context SOURCE_ID .local/messages.json
npm run local:contract -- recall SOURCE_ID
npm run local:contract -- redline SOURCE_ID .local/plan.json
```

`messages.json` is an array of records with `id`, `role` (`user` or `assistant`), `channel` (`imessage`), `text`, and an ISO `at` timestamp. Stable IDs avoid duplicate records. The redline plan uses the inspected `sourceSha256` and `changes` containing `paragraphId`, `original`, `replacement` and `reason`. These commands exercise local files; they do not send iMessages.

The Mac app also needs its separate `.local/voice.env` and signing configuration. See the [desktop setup guide](../README.md#run-on-screen-cleo).

## Hosted pairing

Configure the backend's `CLEO_DESKTOP_TOKEN` and `CLEO_DESKTOP_SENDER` to bind a dedicated token to the intended verified sender. Give the desktop only that token and the HTTPS backend origin through `.local/context.env`. Provider credentials stay on the backend. The model cannot select another user by supplying a different owner field.

`CLEO_CONTEXT_DB` must point to persistent storage. `SUPERMEMORY_API_KEY` is optional. The current SQLite context store assumes a single backend instance; it is not shared coordination for several instances.

## Google review copies

Google support is optional. The local authorization command expects a Desktop OAuth client file at `.local/google-client.json` from a Google Cloud project with the Docs and Drive APIs enabled and the intended account allowed to use the OAuth app.

```sh
npm run google:authorize
```

The command uses a loopback callback, requests `drive.file`, and stores local authorization under `.local/`. Restart the backend after setup. Hosted instances can instead receive the same OAuth JSON objects through `CLEO_GOOGLE_CLIENT_JSON` and `CLEO_GOOGLE_OAUTH_JSON` runtime secrets. Use your own account and credentials.

Generated review copies disclose their text-only conversion. Verified original/proposed wording is checked before a result is reported as successful. Public-link sharing is not automatic for new users. Same-document suggestions are limited to the paired user's verified generated copies and are not accepted on their behalf.

## What memory does and does not save

The iMessage agent must call the recording tools; this is not a complete automatic message-history feed. Desktop voice saves completed user transcriptions after a contract is selected. It does not automatically save unbound speech, assistant speech or audio as a complete transcript.

Select a contract explicitly, or resolve an eligible Google Doc through its verified mapping. Supported browser identity can be read with macOS Accessibility permission. Screen text alone does not prove which private contract is open.

Identical source documents used for separate negotiations need a more explicit matter identity before broader use. This prototype does not provide a retention/deletion interface, multi-user Google OAuth, or automatic lawyer routing.
