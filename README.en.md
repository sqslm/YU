# YU / 语

**Use your own words to work with your computer.** [中文](README.md) · [Design philosophy (Chinese)](resources/brand/PHILOSOPHY.zh-CN.md)

YU is a Windows desktop voice assistant. It preserves quick dictation while bringing questions, notes, reminders and registered local tools into the same voice entry. Version **1.0.0-rc.2** is a release candidate, not a claim that every roadmap feature is finished.

RC.2 fixes the distinction between a failed search and a successful empty search. Just after midnight, recent reports remain available with their actual dates when no report is verified as today’s news. Local calendar dates are used consistently. Release-candidate version comparisons now follow prerelease precedence.

Provider forms include official platform/documentation and key application links, opened with the default browser. Local/custom connections do not claim an unrelated vendor. Wake detection accepts moderately confident complete long phrases while keeping stricter short-phrase checks, exact grammar matching, ordinary-speech competition and the cooldown. Synthesized speech tests do not guarantee performance for every microphone or noisy room.

## Available today

- Dictation, translation, Ask and prompt cards with application routing; live captions and task feedback above the voice bar.
- Notes with independent titles, original ASR text, polished drafts, recordings, categories and tags.
- Local reminders and untimed tasks, recurrence, strong reminders and persistent missed-reminder notices on restart/resume.
- Screenshot window snapping, annotations with resize handles, copy/save, Windows OCR, and translation or visual Ask when the configured provider supports them.
- Registered Windows application/folder/document/URL opening and bounded file metadata searches. Ordinary requested actions run directly; destructive, irreversible actions and arbitrary shell commands are refused.
- Optional offline Windows speech wake-up, off by default. The corresponding system speech language pack is required. Built-in ASR model files are downloaded separately.
- Chinese/English interfaces, light/dark themes and an optional self-hosted account/sync server.

Calendar/ICS, long-term personal memory, daily briefings, TTS and saved workflows are not implemented. See the [implementation record](ASSISTANT_ROADMAP.md) for tested behavior and limits. Speech recognition, OCR and intent routing can make mistakes; verify important results.

## Build and test

Use Windows x64, Node.js 22.18 or newer and pnpm 11. Reuse the project lockfile.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev
pnpm package
```

`pnpm icon` copies the supplied brand assets into their runtime/build destinations and needs Python 3 (standard library only). `pnpm package` creates `release/YU-1.0.0-rc.2-setup.exe`. Native keyboard, screenshot and local speech features require Windows. FFmpeg is optional for importing non-PCM recordings and is not bundled.

After committing, `pnpm release:archives` creates the server archive and release checksums from Git. It does not create a source ZIP unless `--source` is explicitly supplied. GitHub publishing and update hosting require separate configuration. Installers are unsigned unless a code-signing identity is configured.

## Privacy and upgrades

Local features work without login or a dedicated server. No personal server URL is configured by default. Expand Advanced on the login form only when configuring your own server. Cloud synchronization is optional; [server setup and security limits](server/README.md) explain its plaintext server-side storage.

Remote ASR/LLM providers receive the audio, text or images needed for a user-triggered task. Wake detection uses local Windows speech recognition, without uploading pre-wake audio. Clipboard and screenshots are not monitored continuously. Diagnostic exports redact credentials, URLs, email addresses, private IPs and local paths; review other free-form content before sharing.

The package ID, Windows application ID and existing data directory retain their legacy technical identifiers for upgrade compatibility. Renaming the product does not clear settings or sign-in tokens. Windows tokens stay encrypted for the same OS user; revocation, expiration, changing users or deleting application data still requires sign-in.

Do not commit `.env`, private keys, account data, model weights, logs or release binaries. The default update feed is a placeholder. No live update service or remote server deployment is implied by this release.

## Design and licensing

YU helps users express themselves naturally, keeps existing meaning intact and returns quietly to the background. The open-door symbol represents a natural way into the computer. The application shows **语** in Chinese and **YU** in English.

Code is licensed under [MIT](LICENSE). Third-party software retains its own licenses; see [notices](THIRD_PARTY_NOTICES.md). Model licenses apply separately. This is an independent project and is not affiliated with Typeless.
