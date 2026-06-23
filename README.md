This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Required environment variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
R2_BUCKET_NAME=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ENDPOINT=
TRIGGER_SECRET_KEY=
ASSEMBLYAI_API_KEY=
OPENAI_API_KEY=
OPENAI_WORKER_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=high
OPENAI_IMAGE_DETAIL=high
OPENAI_VISUAL_ANALYSIS_MAX_OUTPUT_TOKENS=20000
OPENAI_EDIT_PLAN_MAX_OUTPUT_TOKENS=20000
OPENAI_OVERLAY_PLAN_MAX_OUTPUT_TOKENS=10000
OPENAI_INSTRUCTION_DOCUMENT_MAX_OUTPUT_TOKENS=12000
OPENAI_VOICEOVER_SCRIPT_MAX_OUTPUT_TOKENS=6000
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
VIDEO_ANALYSIS_PROVIDER=openai
TWELVELABS_API_KEY=
TWELVELABS_ANALYZE_MODEL=pegasus1.5
GEMINI_API_KEY=
GEMINI_VIDEO_MODEL=gemini-3.5-flash
GEMINI_VIDEO_EVENT_ANALYSIS_ENABLED=false
GEMINI_VIDEO_EVENT_ANALYSIS_REQUIRED=false
VIDEO_STYLE=instruction_overlay
```

Supabase Auth is used for magic-link sign-in. Add the local and production app
URLs to Supabase Auth redirect allow-list, including
`http://localhost:3000/auth/callback` for local development and the production
`/auth/callback` URL for deployment. `NEXT_PUBLIC_SITE_URL` is optional and is
used as a fallback origin for sign-in links when request headers are not
available.

For local UI development only, set `AUTH_DISABLED_FOR_DEV=true` in `.env.local`
to skip magic-link sign-in. This flag is ignored when `NODE_ENV=production`.

To turn off the app login gate in production, set `AUTH_DISABLED=true` in the
deployment environment. Supabase is still required for database access, but the
app will skip Supabase Auth and treat all visitors as a shared bypass user. This
makes the app public to anyone with the URL, including access to paid upload and
processing services.

`ASSEMBLYAI_BASE_URL` is optional and defaults to `https://api.assemblyai.com`.
`OPENAI_BASE_URL` is optional and defaults to `https://api.openai.com/v1`.
`OPENAI_WORKER_MODEL` is optional and defaults to `gpt-5.5`.
`OPENAI_REASONING_EFFORT` is optional and defaults to `high` for worker
Responses API calls. Supported values are `none`, `low`, `medium`, `high`, and
`xhigh`; higher values can improve complex planning quality but usually increase
latency and token cost. `OPENAI_IMAGE_DETAIL` is optional and defaults to
`high` for sampled-frame visual analysis; supported values are `low`, `high`,
and `auto`. The `OPENAI_*_MAX_OUTPUT_TOKENS` settings are optional per-stage
limits for OpenAI Responses output, including reasoning tokens, and default to
the values shown in the required environment example above.
`OPENAI_TTS_MODEL` is optional and defaults to `gpt-4o-mini-tts`.
`OPENAI_TTS_VOICE` is optional and defaults to `cedar`.
`OPENAI_TTS_INSTRUCTIONS` is optional and can provide voice style guidance for
the OpenAI speech request.
Generated voiceover audio uses OpenAI text to speech. Subtitle timing uses a
second AssemblyAI transcription pass over the generated voiceover, so
`ASSEMBLYAI_API_KEY` is required for both source transcription and subtitle
timing. OpenAI requires disclosure to end users that they are hearing an
AI-generated voice.
`VIDEO_ANALYSIS_PROVIDER` controls the optional whole-video analysis pass. Set
it to `twelvelabs` for paid timestamped action segmentation, `gemini` for the
Gemini whole-video fallback, or `openai` to use only the existing transcript plus
sampled-frame OpenAI visual analysis. `TWELVELABS_API_KEY` is required when
`VIDEO_ANALYSIS_PROVIDER=twelvelabs`; `TWELVELABS_ANALYZE_MODEL` is optional and
defaults to `pegasus1.5`.
`GEMINI_VIDEO_MODEL` is optional and defaults to `gemini-3.5-flash`.
`GEMINI_VIDEO_EVENT_ANALYSIS_ENABLED` controls optional Gemini whole-video
event analysis. `GEMINI_VIDEO_EVENT_ANALYSIS_REQUIRED` defaults to `false`; when
it is `false`, Gemini failures are logged and the existing transcript plus
sampled-frame pipeline continues.
`VISUAL_FRAME_SAMPLE_INTERVAL_SECONDS` and
`VISUAL_FRAME_SAMPLE_MAX_FRAMES` are optional visual-analysis worker settings
and default to `3` and `30`.
`VIDEO_STYLE` defaults to `instruction_overlay`, which adds one readable
Vidocu-style action caption per selected segment. Set it to
`voiceover_subtitles` to keep the older voiceover/subtitle presentation.

Before running the worker against a fresh database, apply the Supabase migrations in `supabase/migrations/` in order.
For production Gemini rollout, apply
`supabase/migrations/20260612000000_add_video_event_analysis_field.sql` before
deploying app or worker code that reads `video_event_analysis_r2_key`.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
